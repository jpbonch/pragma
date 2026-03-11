import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import {
  DEFAULT_AGENT_ID,
  SalmonError,
  createWorkspace,
  deleteWorkspace,
  closeOpenDatabases,
  getActiveWorkspaceName,
  getWorkspacePaths,
  listWorkspaceNames,
  openDatabase,
  parseLimit,
  setActiveWorkspaceName,
  setupSalmon,
} from "./db";
import { getConversationAdapter } from "./conversation/adapters";
import { ExecuteRunner } from "./conversation/executeRunner";
import { resolveModelId } from "./conversation/models";
import { buildPrompt, parsePlanSummary } from "./conversation/prompts";
import {
  closeThread,
  createThread,
  createTurn,
  ensureConversationSchema,
  getLatestCompletedPlanTurn,
  getLatestExecuteTurn,
  getThreadByJobId,
  getThreadById,
  getThreadWithDetails,
  insertEvent,
  insertMessage,
  listChatThreads,
  reopenThread,
  setThreadJobId,
  updateChatThreadMetadata,
  updateThreadSession,
  completeTurn,
  failTurn,
} from "./conversation/store";
import type { HarnessId, ReasoningEffort } from "./conversation/types";

type StartServerOptions = {
  port: number;
};

export async function startServer(options: StartServerOptions): Promise<void> {
  await setupSalmon();
  const executeRunner = new ExecuteRunner();

  const app = new Hono();
  app.use("*", cors());

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/setup", async (c) => {
    await setupSalmon();
    return c.json({ ok: true });
  });

  app.get("/workspaces", async (c) => {
    const [names, activeName] = await Promise.all([
      listWorkspaceNames(),
      getActiveWorkspaceName(),
    ]);

    const workspaces = names.map((name) => ({
      name,
      active: name === activeName,
    }));

    return c.json({ workspaces });
  });

  app.get("/workspace/active", async (c) => {
    const activeName = await getActiveWorkspaceName();
    return c.json({ workspace: activeName ? { name: activeName } : null });
  });

  app.post("/workspaces", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new SalmonError("INVALID_JSON", 400, "Invalid JSON body.");
    }

    if (!isCreateWorkspaceBody(body)) {
      throw new SalmonError(
        "INVALID_WORKSPACE_REQUEST",
        400,
        "`name` and `goal` are required.",
      );
    }

    await createWorkspace({ name: body.name, goal: body.goal });

    return c.json({
      ok: true,
      workspace: { name: body.name, active: true },
    });
  });

  app.post("/workspaces/active", async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new SalmonError("INVALID_JSON", 400, "Invalid JSON body.");
    }

    if (!isSetActiveWorkspaceBody(body)) {
      throw new SalmonError(
        "INVALID_WORKSPACE_REQUEST",
        400,
        "`name` is required.",
      );
    }

    await setActiveWorkspaceName(body.name);
    return c.json({ ok: true });
  });

  app.delete("/workspaces/:name", async (c) => {
    const name = c.req.param("name");
    const result = await deleteWorkspace(name);
    return c.json({
      ok: true,
      active: result.nextActive ? { name: result.nextActive } : null,
    });
  });

  app.get("/agents", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const db = await openDatabase(workspaceName);

    try {
      const result = await db.query<{
        id: string;
        name: string;
        status: string;
        agent_file: string | null;
        emoji: string | null;
        harness: HarnessId;
        model_label: string;
        model_id: string;
      }>(`
SELECT id, name, status, agent_file, emoji, harness, model_label, model_id
FROM agents
ORDER BY name ASC
`);

      return c.json({ agents: result.rows });
    } finally {
      await db.close();
    }
  });

  app.post("/agents", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new SalmonError("INVALID_JSON", 400, "Invalid JSON body.");
    }

    if (!isCreateAgentBody(body)) {
      throw new SalmonError(
        "INVALID_AGENT",
        400,
        "`name` is required.",
      );
    }

    const db = await openDatabase(workspaceName);
    try {
      const harness = body.harness ?? "claude_code";
      const modelLabel = body.model_label?.trim() || defaultModelLabelForHarness(harness);
      const modelId = resolveModelId(harness, modelLabel);
      const agentId = await generateNextAgentId(db, body.name);
      await db.query(
        `
INSERT INTO agents (id, name, status, agent_file, emoji, harness, model_label, model_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
`,
        [
          agentId,
          body.name.trim(),
          "idle",
          body.agent_file ?? null,
          body.emoji ?? "🤖",
          harness,
          modelLabel,
          modelId,
        ],
      );

      return c.json({ ok: true, id: agentId }, 201);
    } catch (error: unknown) {
      const message = errorMessage(error);
      throw new SalmonError("CREATE_AGENT_FAILED", 400, message);
    } finally {
      await db.close();
    }
  });

  app.put("/agents/:id", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const id = c.req.param("id");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new SalmonError("INVALID_JSON", 400, "Invalid JSON body.");
    }

    if (!isUpdateAgentBody(body)) {
      throw new SalmonError(
        "INVALID_AGENT",
        400,
        "`name`, `agent_file`, `emoji`, `harness`, and `model_label` are required.",
      );
    }

    const db = await openDatabase(workspaceName);
    try {
      const modelId = resolveModelId(body.harness, body.model_label);
      const updated = await db.query(
        `
UPDATE agents
SET name = $2,
    agent_file = $3,
    emoji = $4,
    harness = $5,
    model_label = $6,
    model_id = $7
WHERE id = $1
`,
        [
          id,
          body.name.trim(),
          body.agent_file.trim(),
          body.emoji.trim(),
          body.harness,
          body.model_label.trim(),
          modelId,
        ],
      );

      if ((updated.affectedRows ?? 0) === 0) {
        throw new SalmonError("AGENT_NOT_FOUND", 404, `Agent not found: ${id}`);
      }

      return c.json({ ok: true });
    } finally {
      await db.close();
    }
  });

  app.get("/jobs", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const status = c.req.query("status");
    const limitValue = c.req.query("limit") ?? "25";
    const limit = parseLimit(limitValue);

    const db = await openDatabase(workspaceName);

    try {
      const params: Array<string | number> = [limit];
      let query = `
SELECT j.id,
       j.title,
       j.status,
       j.assigned_to,
       j.output_dir,
       j.session_id,
       j.created_at,
       (
         SELECT ct.id
         FROM conversation_threads ct
         WHERE ct.job_id = j.id
         ORDER BY ct.created_at DESC
         LIMIT 1
       ) AS thread_id
FROM jobs j
`;

      if (status) {
        query += "WHERE status = $2\n";
        params.push(status);
      }

      query += "ORDER BY created_at DESC\nLIMIT $1";

      const result = await db.query<{
        id: string;
        title: string;
        status: string;
        assigned_to: string | null;
        output_dir: string | null;
        session_id: string | null;
        created_at: string;
        thread_id: string | null;
      }>(query, params);

      return c.json({ jobs: result.rows });
    } finally {
      await db.close();
    }
  });

  app.post("/jobs", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new SalmonError("INVALID_JSON", 400, "Invalid JSON body.");
    }

    if (!isCreateJobBody(body)) {
      throw new SalmonError("INVALID_JOB", 400, "`title` is required.");
    }

    const jobId = `job_${randomUUID().slice(0, 8)}`;
    const db = await openDatabase(workspaceName);

    try {
      await db.query(
        `
INSERT INTO jobs (id, title, status, assigned_to, output_dir, session_id)
VALUES ($1, $2, $3, $4, $5, $6)
`,
        [
          jobId,
          body.title,
          body.status ?? "open",
          body.assigned_to ?? null,
          body.output_dir ?? null,
          body.session_id ?? null,
        ],
      );
    } catch (error: unknown) {
      throw new SalmonError("CREATE_JOB_FAILED", 400, errorMessage(error));
    } finally {
      await db.close();
    }

    return c.json({ id: jobId }, 201);
  });

  app.post("/jobs/execute", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new SalmonError("INVALID_JSON", 400, "Invalid JSON body.");
    }

    if (!isCreateExecuteJobBody(body)) {
      throw new SalmonError(
        "INVALID_EXECUTE_JOB",
        400,
        "`prompt` is required.",
      );
    }
    const prompt = body.prompt.trim();
    const reasoningEffort = parseReasoningEffort(body.reasoning_effort);
    const title = prompt.length > 100 ? `${prompt.slice(0, 97)}...` : prompt;
    const jobId = `job_${randomUUID().slice(0, 8)}`;
    const threadId = `thread_${randomUUID().slice(0, 12)}`;

    const db = await openDatabase(workspaceName);
    try {
      await ensureConversationSchema(db);
      const orchestrator = await getAgentRow(db, DEFAULT_AGENT_ID);
      if (!orchestrator) {
        throw new SalmonError(
          "ORCHESTRATOR_NOT_FOUND",
          400,
          `Orchestrator agent is missing: ${DEFAULT_AGENT_ID}`,
        );
      }

      let requestedRecipientAgentId: string | null = null;
      if (body.recipient_agent_id) {
        requestedRecipientAgentId = body.recipient_agent_id.trim();
        if (!requestedRecipientAgentId) {
          throw new SalmonError("INVALID_RECIPIENT", 400, "recipient_agent_id cannot be empty.");
        }

        const recipient = await getAgentRow(db, requestedRecipientAgentId);
        if (!recipient || recipient.id === DEFAULT_AGENT_ID) {
          throw new SalmonError(
            "INVALID_RECIPIENT",
            400,
            `Invalid recipient agent id: ${requestedRecipientAgentId}`,
          );
        }
      }

      await db.query(
        `
INSERT INTO jobs (id, title, status, assigned_to, output_dir, session_id)
VALUES ($1, $2, 'open', NULL, NULL, NULL)
`,
        [jobId, title || "Execute task"],
      );

      await createThread(db, {
        id: threadId,
        mode: "execute",
        harness: orchestrator.harness,
        modelLabel: orchestrator.model_label,
        modelId: orchestrator.model_id,
        sourceThreadId: null,
        jobId,
      });

      executeRunner.enqueue({
        workspaceName,
        jobId,
        threadId,
        prompt,
        requestedRecipientAgentId,
        reasoningEffort,
      });
    } catch (error: unknown) {
      if (error instanceof SalmonError) {
        throw error;
      }
      throw new SalmonError("CREATE_EXECUTE_JOB_FAILED", 400, errorMessage(error));
    } finally {
      await db.close();
    }

    return c.json({ job_id: jobId }, 201);
  });

  app.post("/jobs/:jobId/recipient", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const jobId = c.req.param("jobId");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new SalmonError("INVALID_JSON", 400, "Invalid JSON body.");
    }

    if (!isJobRecipientBody(body)) {
      throw new SalmonError(
        "INVALID_RECIPIENT_REQUEST",
        400,
        "`recipient_agent_id` is required.",
      );
    }

    const recipientAgentId = body.recipient_agent_id.trim();
    const db = await openDatabase(workspaceName);

    try {
      await ensureConversationSchema(db);
      const jobResult = await db.query<{ id: string; status: string }>(
        `
SELECT id, status
FROM jobs
WHERE id = $1
LIMIT 1
`,
        [jobId],
      );
      const job = jobResult.rows[0];
      if (!job) {
        throw new SalmonError("JOB_NOT_FOUND", 404, `Job not found: ${jobId}`);
      }
      if (job.status !== "needs_input") {
        throw new SalmonError(
          "JOB_NOT_WAITING_FOR_RECIPIENT",
          409,
          `Job is not waiting for recipient input: ${jobId}`,
        );
      }

      const recipient = await getAgentRow(db, recipientAgentId);
      if (!recipient || recipient.id === DEFAULT_AGENT_ID) {
        throw new SalmonError("INVALID_RECIPIENT", 400, `Invalid recipient agent id: ${recipientAgentId}`);
      }

      const thread = await getThreadByJobId(db, jobId);
      if (!thread) {
        throw new SalmonError("JOB_THREAD_NOT_FOUND", 404, `No conversation thread found for job: ${jobId}`);
      }

      const latestExecuteTurn = await getLatestExecuteTurn(db, thread.id);
      if (!latestExecuteTurn || !latestExecuteTurn.user_message.trim()) {
        throw new SalmonError("NO_EXECUTE_PROMPT", 409, "No execute task prompt is available for this job.");
      }

      await db.query(
        `
UPDATE jobs
SET status = 'open'
WHERE id = $1
`,
        [jobId],
      );

      executeRunner.enqueue({
        workspaceName,
        jobId,
        threadId: thread.id,
        prompt: latestExecuteTurn.user_message,
        requestedRecipientAgentId: recipientAgentId,
        reasoningEffort: latestExecuteTurn.reasoning_effort ?? "medium",
      });
    } finally {
      await db.close();
    }

    return c.json({ ok: true });
  });

  app.get("/conversations/chats", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const limitValue = c.req.query("limit") ?? "20";
    const cursor = c.req.query("cursor") ?? null;
    const limit = parseLimit(limitValue);
    const db = await openDatabase(workspaceName);

    try {
      await ensureConversationSchema(db);
      const chats = await listChatThreads(db, { limit, cursor });
      return c.json({ chats });
    } finally {
      await db.close();
    }
  });

  app.get("/conversations/:threadId", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const threadId = c.req.param("threadId");
    const db = await openDatabase(workspaceName);

    try {
      await ensureConversationSchema(db);
      const data = await getThreadWithDetails(db, threadId);
      if (!data.thread) {
        throw new SalmonError("THREAD_NOT_FOUND", 404, `Conversation thread not found: ${threadId}`);
      }

      const events = data.events.map((event) => ({
        ...event,
        payload: safeParseJson(event.payload_json),
      }));

      return c.json({
        thread: data.thread,
        turns: data.turns,
        messages: data.messages,
        events,
      });
    } finally {
      await db.close();
    }
  });

  app.post("/conversations/turns/stream", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new SalmonError("INVALID_JSON", 400, "Invalid JSON body.");
    }

    if (!isConversationTurnBody(body)) {
      throw new SalmonError(
        "INVALID_CONVERSATION_TURN",
        400,
        "`message`, `mode`, `harness`, and `model_label` are required.",
      );
    }

    const modelId = resolveModelId(body.harness, body.model_label);
    const reasoningEffort = parseReasoningEffort(body.reasoning_effort);
    const db = await openDatabase(workspaceName);
    await ensureConversationSchema(db);
    const paths = getWorkspacePaths(workspaceName);
    const adapter = getConversationAdapter(body.harness);
    try {
      const requestedRecipientAgentId =
        body.mode === "plan" ? (body.recipient_agent_id?.trim() || null) : null;
      if (requestedRecipientAgentId) {
        const recipient = await getAgentRow(db, requestedRecipientAgentId);
        if (!recipient || recipient.id === DEFAULT_AGENT_ID) {
          throw new SalmonError(
            "INVALID_RECIPIENT",
            400,
            `Invalid recipient agent id: ${requestedRecipientAgentId}`,
          );
        }
      }

      let threadId = body.thread_id ?? `thread_${randomUUID().slice(0, 12)}`;
      let thread = await getThreadById(db, threadId);
      let isNewThread = false;

      if (!thread) {
        isNewThread = true;
        await createThread(db, {
          id: threadId,
          mode: body.mode,
          harness: body.harness,
          modelLabel: body.model_label,
          modelId,
        });
        thread = await getThreadById(db, threadId);
      }

      if (!thread) {
        throw new SalmonError("THREAD_CREATE_FAILED", 400, "Could not create conversation thread.");
      }

      if (thread.harness !== body.harness) {
        throw new SalmonError(
          "THREAD_HARNESS_MISMATCH",
          409,
          "Thread harness does not match the requested harness.",
        );
      }

      if (thread.status === "closed") {
        if (thread.mode === "execute") {
          await reopenThread(db, thread.id);
          thread = await getThreadById(db, thread.id);
        } else {
          throw new SalmonError("THREAD_CLOSED", 409, "Conversation thread is already closed.");
        }
      }

      if (!thread) {
        throw new SalmonError("THREAD_NOT_FOUND", 404, `Conversation thread not found: ${threadId}`);
      }

      const turnId = `turn_${randomUUID().slice(0, 12)}`;
      const userMessageId = `msg_${randomUUID().slice(0, 12)}`;
      const message = body.message.trim();

      await createTurn(db, {
        id: turnId,
        threadId,
        mode: body.mode,
        userMessage: message,
        reasoningEffort,
        requestedRecipientAgentId,
      });

      await insertMessage(db, {
        id: userMessageId,
        threadId,
        turnId,
        role: "user",
        content: message,
      });

      await insertEvent(db, {
        id: `evt_${randomUUID().slice(0, 12)}`,
        threadId,
        turnId,
        eventName: "user_message_saved",
        payload: { message_id: userMessageId },
      });

      return streamSSE(c, async (stream) => {
      try {
        if (isNewThread) {
          const startedPayload = { thread_id: threadId };
          await insertEvent(db, {
            id: `evt_${randomUUID().slice(0, 12)}`,
            threadId,
            turnId,
            eventName: "thread_started",
            payload: startedPayload,
          });
          await stream.writeSSE({
            event: "thread_started",
            data: JSON.stringify(startedPayload),
          });
        }

        await stream.writeSSE({
          event: "user_message_saved",
          data: JSON.stringify({ message_id: userMessageId }),
        });

        let assistantText = "";

        const result = await adapter.sendTurn({
          prompt: buildPrompt(body.mode, message, reasoningEffort),
          modelId,
          sessionId: thread.harness_session_id,
          cwd: paths.codeDir,
          mode: body.mode,
          reasoningEffort,
          onEvent: async (event) => {
            if (event.type === "assistant_text") {
              assistantText = assistantText ? `${assistantText}\n${event.delta}` : event.delta;
              await insertEvent(db, {
                id: `evt_${randomUUID().slice(0, 12)}`,
                threadId,
                turnId,
                eventName: "assistant_text",
                payload: event,
              });
              await stream.writeSSE({
                event: "assistant_text",
                data: JSON.stringify({ delta: event.delta, turn_id: turnId }),
              });
              return;
            }

            await insertEvent(db, {
              id: `evt_${randomUUID().slice(0, 12)}`,
              threadId,
              turnId,
              eventName: "tool_event",
              payload: event,
            });
            await stream.writeSSE({
              event: "tool_event",
              data: JSON.stringify({
                name: event.name,
                payload: event.payload,
                turn_id: turnId,
              }),
            });
          },
        });

        const finalAssistantText = (result.finalText || assistantText || "").trim();
        const assistantMessageId = `msg_${randomUUID().slice(0, 12)}`;
        const planSummary = body.mode === "plan" ? parsePlanSummary(finalAssistantText) : null;

        await completeTurn(db, {
          turnId,
          assistantMessage: finalAssistantText,
          planSummary: planSummary ? JSON.stringify(planSummary) : null,
        });

        await insertMessage(db, {
          id: assistantMessageId,
          threadId,
          turnId,
          role: "assistant",
          content: finalAssistantText,
        });

        if (body.mode === "chat") {
          const previewSource = finalAssistantText || message;
          const chatTitle = deriveChatTitle(finalAssistantText, message);
          await updateChatThreadMetadata(db, {
            threadId,
            title: chatTitle,
            preview: truncateChatText(previewSource, 140),
            lastMessageAt: new Date().toISOString(),
          });
        }

        await updateThreadSession(db, {
          threadId,
          sessionId: result.sessionId,
        });

        const turnCompletedPayload = {
          turn_id: turnId,
          assistant_message_id: assistantMessageId,
          plan_summary: planSummary,
        };

        await insertEvent(db, {
          id: `evt_${randomUUID().slice(0, 12)}`,
          threadId,
          turnId,
          eventName: "turn_completed",
          payload: turnCompletedPayload,
        });

        await stream.writeSSE({
          event: "turn_completed",
          data: JSON.stringify(turnCompletedPayload),
        });
      } catch (error: unknown) {
        const messageText = errorMessage(error);

        await failTurn(db, turnId, messageText);
        await insertEvent(db, {
          id: `evt_${randomUUID().slice(0, 12)}`,
          threadId,
          turnId,
          eventName: "error",
          payload: { code: "TURN_ERROR", message: messageText },
        });

        await stream.writeSSE({
          event: "error",
          data: JSON.stringify({ code: "TURN_ERROR", message: messageText }),
        });
      } finally {
        await db.close();
      }
      });
    } catch (error) {
      await db.close();
      throw error;
    }
  });

  app.post("/conversations/:threadId/execute", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const threadId = c.req.param("threadId");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new SalmonError("INVALID_JSON", 400, "Invalid JSON body.");
    }

    if (!isExecuteFromThreadBody(body)) {
      throw new SalmonError(
        "INVALID_EXECUTE_REQUEST",
        400,
        "Invalid execute request body.",
      );
    }
    const reasoningEffort = parseReasoningEffort(body.reasoning_effort);
    const db = await openDatabase(workspaceName);
    let jobId = `job_${randomUUID().slice(0, 8)}`;
    let executeThreadId = `thread_${randomUUID().slice(0, 12)}`;
    let executePrompt = "";
    let requestedRecipientAgentId: string | null = null;

    try {
      await ensureConversationSchema(db);
      const orchestrator = await getAgentRow(db, DEFAULT_AGENT_ID);
      if (!orchestrator) {
        throw new SalmonError(
          "ORCHESTRATOR_NOT_FOUND",
          400,
          `Orchestrator agent is missing: ${DEFAULT_AGENT_ID}`,
        );
      }

      if (body.recipient_agent_id) {
        requestedRecipientAgentId = body.recipient_agent_id.trim();
        const recipient = await getAgentRow(db, requestedRecipientAgentId);
        if (!recipient || recipient.id === DEFAULT_AGENT_ID) {
          throw new SalmonError(
            "INVALID_RECIPIENT",
            400,
            `Invalid recipient agent id: ${requestedRecipientAgentId}`,
          );
        }
      }

      const thread = await getThreadById(db, threadId);
      if (!thread) {
        throw new SalmonError("THREAD_NOT_FOUND", 404, `Conversation thread not found: ${threadId}`);
      }

      const latestPlanTurn = await getLatestCompletedPlanTurn(db, threadId);
      if (!latestPlanTurn) {
        throw new SalmonError("NO_PLAN_FOUND", 409, "No completed plan turn found.");
      }

      const parsedSummary = latestPlanTurn.plan_summary
        ? (safeParseJson(latestPlanTurn.plan_summary) as Record<string, unknown> | null)
        : null;

      const planTitle = asString(parsedSummary?.title) || "Plan Execution";
      const planSummaryText =
        asString(parsedSummary?.summary) ||
        (latestPlanTurn.assistant_message ?? latestPlanTurn.user_message);
      const planSteps = asStringArray(parsedSummary?.steps);

      executePrompt = [
        `Implement this plan: ${planTitle}`,
        planSummaryText,
        planSteps.length > 0
          ? `Steps:\\n${planSteps.map((step, index) => `${index + 1}. ${step}`).join("\\n")}`
          : "",
      ]
        .filter(Boolean)
        .join("\\n\\n");

      await db.query(
        `
INSERT INTO jobs (id, title, status, assigned_to, output_dir, session_id)
VALUES ($1, $2, 'open', NULL, NULL, NULL)
`,
        [jobId, `Execute: ${planTitle}`],
      );

      await createThread(db, {
        id: executeThreadId,
        mode: "execute",
        harness: orchestrator.harness,
        modelLabel: orchestrator.model_label,
        modelId: orchestrator.model_id,
        sourceThreadId: threadId,
        jobId,
      });

      await setThreadJobId(db, executeThreadId, jobId);
      await closeThread(db, threadId);
    } finally {
      await db.close();
    }

    executeRunner.enqueue({
      workspaceName,
      jobId,
      threadId: executeThreadId,
      prompt: executePrompt,
      requestedRecipientAgentId,
      reasoningEffort,
    });

    return c.json({ job_id: jobId }, 201);
  });

  app.get("/context", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const paths = getWorkspacePaths(workspaceName);

    const context = await listContext(paths.contextDir);
    return c.json({ context });
  });

  app.post("/context/folders", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const paths = getWorkspacePaths(workspaceName);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new SalmonError("INVALID_JSON", 400, "Invalid JSON body.");
    }

    if (!isCreateContextFolderBody(body)) {
      throw new SalmonError(
        "INVALID_CONTEXT_FOLDER",
        400,
        "`name` is required.",
      );
    }

    const folderName = normalizeContextFolderName(body.name);
    const folderPath = join(paths.contextDir, folderName);
    try {
      await mkdir(folderPath, { recursive: false });
    } catch (error: unknown) {
      const message = errorMessage(error);
      if (message.includes("EEXIST")) {
        throw new SalmonError("CONTEXT_FOLDER_EXISTS", 409, "Folder already exists.");
      }
      throw new SalmonError("CREATE_CONTEXT_FOLDER_FAILED", 400, message);
    }

    return c.json({ ok: true, folder: { name: folderName } }, 201);
  });

  app.post("/context/files", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const paths = getWorkspacePaths(workspaceName);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new SalmonError("INVALID_JSON", 400, "Invalid JSON body.");
    }

    if (!isCreateContextFileBody(body)) {
      throw new SalmonError(
        "INVALID_CONTEXT_FILE",
        400,
        "`name` is required.",
      );
    }

    const fileName = normalizeContextFileName(body.name);
    const folderName =
      typeof body.folder === "string" && body.folder.trim().length > 0
        ? normalizeContextFolderName(body.folder)
        : null;

    const relativePath = folderName ? `${folderName}/${fileName}` : fileName;
    validateContextPath(relativePath);

    const fullPath = join(paths.contextDir, relativePath);
    const title = basename(fileName, ".md");
    const initialContent = `# ${title}\n`;
    try {
      await writeFile(fullPath, initialContent, { encoding: "utf8", flag: "wx" });
    } catch (error: unknown) {
      const message = errorMessage(error);
      if (message.includes("EEXIST")) {
        throw new SalmonError("CONTEXT_FILE_EXISTS", 409, "File already exists.");
      }
      if (message.includes("ENOENT")) {
        throw new SalmonError(
          "CONTEXT_FOLDER_NOT_FOUND",
          404,
          "Folder does not exist.",
        );
      }
      throw new SalmonError("CREATE_CONTEXT_FILE_FAILED", 400, message);
    }

    return c.json({ ok: true, file: { path: relativePath } }, 201);
  });

  app.put("/context/file", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const paths = getWorkspacePaths(workspaceName);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new SalmonError("INVALID_JSON", 400, "Invalid JSON body.");
    }

    if (!isUpdateContextBody(body)) {
      throw new SalmonError(
        "INVALID_CONTEXT_BODY",
        400,
        "`path` and `content` are required.",
      );
    }

    validateContextPath(body.path);
    const fullPath = join(paths.contextDir, body.path);
    try {
      await writeFile(fullPath, body.content, "utf8");
    } catch (error: unknown) {
      const message = errorMessage(error);
      if (message.includes("ENOENT")) {
        throw new SalmonError("CONTEXT_FILE_NOT_FOUND", 404, "File does not exist.");
      }
      throw new SalmonError("UPDATE_CONTEXT_FILE_FAILED", 400, message);
    }

    return c.json({ ok: true });
  });

  app.onError((error, c) => {
    if (error instanceof SalmonError) {
      return c.newResponse(
        JSON.stringify({ error: error.code, message: error.message }),
        toKnownStatusCode(error.status),
        { "content-type": "application/json" },
      );
    }

    const message = errorMessage(error);
    if (message.startsWith("Invalid --limit value:")) {
      return c.json({ error: "INVALID_LIMIT", message }, 400);
    }

    return c.json({ error: "INTERNAL_ERROR", message }, 500);
  });

  const server = serve({ fetch: app.fetch, port: options.port }, (info) => {
    console.log(`Salmon API listening on http://127.0.0.1:${info.port}`);
  });

  const shutdown = () => {
    server.close();
    void closeOpenDatabases().finally(() => {
      process.exit(0);
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}

type CreateWorkspaceBody = {
  name: string;
  goal: string;
};

type SetActiveWorkspaceBody = {
  name: string;
};

type CreateJobBody = {
  title: string;
  status?: string;
  assigned_to?: string;
  output_dir?: string;
  session_id?: string;
};

type CreateExecuteJobBody = {
  prompt: string;
  recipient_agent_id?: string;
  reasoning_effort?: string;
};

type ConversationTurnBody = {
  thread_id?: string;
  message: string;
  mode: "chat" | "plan";
  harness: HarnessId;
  model_label: string;
  recipient_agent_id?: string;
  reasoning_effort?: string;
};

type ExecuteFromThreadBody = {
  recipient_agent_id?: string;
  reasoning_effort?: string;
};

type JobRecipientBody = {
  recipient_agent_id: string;
};

type CreateAgentBody = {
  name: string;
  agent_file?: string;
  emoji?: string;
  harness?: HarnessId;
  model_label?: string;
};

type UpdateAgentBody = {
  name: string;
  agent_file: string;
  emoji: string;
  harness: HarnessId;
  model_label: string;
};

type UpdateContextBody = {
  path: string;
  content: string;
};

type CreateContextFolderBody = {
  name: string;
};

type CreateContextFileBody = {
  name: string;
  folder?: string;
};

function isCreateWorkspaceBody(value: unknown): value is CreateWorkspaceBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const body = value as Record<string, unknown>;
  if (typeof body.name !== "string" || body.name.trim().length === 0) {
    return false;
  }
  if (typeof body.goal !== "string" || body.goal.trim().length === 0) {
    return false;
  }

  return true;
}

function isSetActiveWorkspaceBody(value: unknown): value is SetActiveWorkspaceBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const body = value as Record<string, unknown>;
  return typeof body.name === "string" && body.name.trim().length > 0;
}

function isCreateJobBody(value: unknown): value is CreateJobBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const body = value as Record<string, unknown>;
  if (typeof body.title !== "string" || body.title.trim().length === 0) {
    return false;
  }

  const optionalStringFields = [
    "status",
    "assigned_to",
    "output_dir",
    "session_id",
  ] as const;

  for (const field of optionalStringFields) {
    const fieldValue = body[field];
    if (fieldValue !== undefined && typeof fieldValue !== "string") {
      return false;
    }
  }

  return true;
}

function isCreateExecuteJobBody(value: unknown): value is CreateExecuteJobBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const body = value as Record<string, unknown>;
  if (typeof body.prompt !== "string" || body.prompt.trim().length === 0) {
    return false;
  }
  if (body.recipient_agent_id !== undefined) {
    if (typeof body.recipient_agent_id !== "string" || body.recipient_agent_id.trim().length === 0) {
      return false;
    }
  }
  if (body.reasoning_effort !== undefined && !isReasoningEffort(body.reasoning_effort)) {
    return false;
  }
  return true;
}

function isJobRecipientBody(value: unknown): value is JobRecipientBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const body = value as Record<string, unknown>;
  if (typeof body.recipient_agent_id !== "string" || body.recipient_agent_id.trim().length === 0) {
    return false;
  }
  return true;
}

function isConversationTurnBody(value: unknown): value is ConversationTurnBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const body = value as Record<string, unknown>;
  if (body.thread_id !== undefined && typeof body.thread_id !== "string") {
    return false;
  }
  if (typeof body.message !== "string" || body.message.trim().length === 0) {
    return false;
  }
  if (body.mode !== "chat" && body.mode !== "plan") {
    return false;
  }
  if (!isHarness(body.harness)) {
    return false;
  }
  if (typeof body.model_label !== "string" || body.model_label.trim().length === 0) {
    return false;
  }
  if (body.recipient_agent_id !== undefined) {
    if (body.mode !== "plan") {
      return false;
    }
    if (typeof body.recipient_agent_id !== "string" || body.recipient_agent_id.trim().length === 0) {
      return false;
    }
  }
  if (body.reasoning_effort !== undefined && !isReasoningEffort(body.reasoning_effort)) {
    return false;
  }
  return true;
}

function isExecuteFromThreadBody(value: unknown): value is ExecuteFromThreadBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const body = value as Record<string, unknown>;
  if (body.recipient_agent_id !== undefined) {
    if (typeof body.recipient_agent_id !== "string" || body.recipient_agent_id.trim().length === 0) {
      return false;
    }
  }
  if (body.reasoning_effort !== undefined && !isReasoningEffort(body.reasoning_effort)) {
    return false;
  }
  const knownKeys = new Set(["recipient_agent_id", "reasoning_effort"]);
  for (const key of Object.keys(body)) {
    if (!knownKeys.has(key)) {
      return false;
    }
  }
  return true;
}

function isCreateAgentBody(value: unknown): value is CreateAgentBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const body = value as Record<string, unknown>;
  if (typeof body.name !== "string" || body.name.trim().length === 0) {
    return false;
  }
  if (body.agent_file !== undefined && typeof body.agent_file !== "string") {
    return false;
  }
  if (body.emoji !== undefined && typeof body.emoji !== "string") {
    return false;
  }
  if (body.harness !== undefined && !isHarness(body.harness)) {
    return false;
  }
  if (body.model_label !== undefined) {
    if (typeof body.model_label !== "string" || body.model_label.trim().length === 0) {
      return false;
    }
  }

  return true;
}

function isUpdateAgentBody(value: unknown): value is UpdateAgentBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const body = value as Record<string, unknown>;
  if (typeof body.name !== "string" || body.name.trim().length === 0) {
    return false;
  }
  if (typeof body.agent_file !== "string") {
    return false;
  }
  if (typeof body.emoji !== "string" || body.emoji.trim().length === 0) {
    return false;
  }
  if (!isHarness(body.harness)) {
    return false;
  }
  if (typeof body.model_label !== "string" || body.model_label.trim().length === 0) {
    return false;
  }

  return true;
}

async function generateNextAgentId(
  db: Awaited<ReturnType<typeof openDatabase>>,
  name: string,
): Promise<string> {
  const base = normalizeAgentIdBase(name);
  const likePattern = `${base}-%`;
  const existing = await db.query<{ id: string }>(
    `
SELECT id
FROM agents
WHERE id = $1 OR id LIKE $2
`,
    [base, likePattern],
  );

  if (existing.rows.length === 0) {
    return base;
  }

  let maxSuffix = -1;
  const suffixRegex = new RegExp(`^${escapeRegex(base)}-(\\d+)$`);

  for (const row of existing.rows) {
    if (row.id === base) {
      maxSuffix = Math.max(maxSuffix, 0);
      continue;
    }

    const match = row.id.match(suffixRegex);
    if (!match) {
      continue;
    }

    const parsed = Number.parseInt(match[1], 10);
    if (Number.isInteger(parsed)) {
      maxSuffix = Math.max(maxSuffix, parsed);
    }
  }

  return `${base}-${Math.max(1, maxSuffix + 1)}`;
}

function normalizeAgentIdBase(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");

  return normalized || "agent";
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isUpdateContextBody(value: unknown): value is UpdateContextBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const body = value as Record<string, unknown>;
  return typeof body.path === "string" && typeof body.content === "string";
}

function isCreateContextFolderBody(value: unknown): value is CreateContextFolderBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const body = value as Record<string, unknown>;
  return typeof body.name === "string" && body.name.trim().length > 0;
}

function isCreateContextFileBody(value: unknown): value is CreateContextFileBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const body = value as Record<string, unknown>;
  if (typeof body.name !== "string" || body.name.trim().length === 0) {
    return false;
  }
  if (body.folder !== undefined && typeof body.folder !== "string") {
    return false;
  }
  return true;
}

function isHarness(value: unknown): value is HarnessId {
  return value === "codex" || value === "claude_code";
}

function isReasoningEffort(value: unknown): value is ReasoningEffort {
  return (
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "extra_high"
  );
}

function parseReasoningEffort(value: unknown): ReasoningEffort {
  return isReasoningEffort(value) ? value : "medium";
}

function defaultModelLabelForHarness(harness: HarnessId): string {
  return harness === "codex" ? "GPT-5" : "Opus 4.6";
}

async function getAgentRow(
  db: Awaited<ReturnType<typeof openDatabase>>,
  id: string,
): Promise<{
  id: string;
  name: string;
  harness: HarnessId;
  model_label: string;
  model_id: string;
  agent_file: string | null;
} | null> {
  const result = await db.query<{
    id: string;
    name: string;
    harness: HarnessId;
    model_label: string;
    model_id: string;
    agent_file: string | null;
  }>(
    `
SELECT id, name, harness, model_label, model_id, agent_file
FROM agents
WHERE id = $1
LIMIT 1
`,
    [id],
  );

  return result.rows[0] ?? null;
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === "string");
}

function deriveChatTitle(assistantMessage: string, userMessage: string): string {
  const assistantFirstSentence = firstSentence(assistantMessage);
  if (assistantFirstSentence) {
    return truncateChatText(assistantFirstSentence, 80);
  }

  const firstUserSentence = firstSentence(userMessage);
  if (firstUserSentence) {
    return truncateChatText(firstUserSentence, 80);
  }

  return "New chat";
}

function firstSentence(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return "";
  }

  const sentenceMatch = normalized.match(/(.+?[.!?])(?:\s|$)/);
  if (sentenceMatch?.[1]) {
    return sentenceMatch[1].trim();
  }

  return normalized;
}

function truncateChatText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}

async function requireActiveWorkspaceName(): Promise<string> {
  const activeWorkspace = await getActiveWorkspaceName();
  if (!activeWorkspace) {
    throw new SalmonError(
      "NO_ACTIVE_WORKSPACE",
      409,
      "No active workspace. Create one or set an active workspace.",
    );
  }

  return activeWorkspace;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function toKnownStatusCode(status: number): 400 | 404 | 409 {
  if (status === 404) {
    return 404;
  }
  if (status === 409) {
    return 409;
  }
  return 400;
}

function validateContextPath(path: string): void {
  if (!path || path.trim().length === 0) {
    throw new SalmonError("INVALID_CONTEXT_PATH", 400, "Path is required.");
  }

  if (!path.toLowerCase().endsWith(".md")) {
    throw new SalmonError(
      "INVALID_CONTEXT_PATH",
      400,
      "Only markdown files can be updated.",
    );
  }

  if (
    path.includes("\\") ||
    path.includes("..") ||
    path.includes("\0")
  ) {
    throw new SalmonError(
      "INVALID_CONTEXT_PATH",
      400,
      "Invalid context path.",
    );
  }

  const parts = path.split("/");
  if (parts.length > 2 || parts.some((part) => part.trim().length === 0)) {
    throw new SalmonError(
      "INVALID_CONTEXT_PATH",
      400,
      "Only root files or one-level folder files are supported.",
    );
  }

  normalizeContextFileName(parts[parts.length - 1]);
  if (parts.length === 2) {
    normalizeContextFolderName(parts[0]);
  }
}

function normalizeContextFileName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new SalmonError("INVALID_CONTEXT_FILE", 400, "File name is required.");
  }
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    trimmed.includes("\0")
  ) {
    throw new SalmonError("INVALID_CONTEXT_FILE", 400, "Invalid file name.");
  }
  if (!trimmed.toLowerCase().endsWith(".md")) {
    throw new SalmonError("INVALID_CONTEXT_FILE", 400, "File name must end with .md.");
  }
  return trimmed;
}

function normalizeContextFolderName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new SalmonError("INVALID_CONTEXT_FOLDER", 400, "Folder name is required.");
  }
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    trimmed.includes("\0")
  ) {
    throw new SalmonError("INVALID_CONTEXT_FOLDER", 400, "Invalid folder name.");
  }
  return trimmed;
}

async function listContext(contextDir: string): Promise<{
  folders: Array<{ name: string }>;
  files: Array<{
    path: string;
    filename: string;
    title: string;
    folder: string | null;
    content: string;
  }>;
}> {
  let entries;
  try {
    entries = await readdir(contextDir, { withFileTypes: true });
  } catch {
    return { folders: [], files: [] };
  }

  const folders = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b))
    .map((name) => ({ name }));

  const rootMarkdownFiles = entries
    .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".md")
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const files: Array<{
    path: string;
    filename: string;
    title: string;
    folder: string | null;
    content: string;
  }> = [];

  for (const filename of rootMarkdownFiles) {
    const fullPath = join(contextDir, filename);
    const content = await readFile(fullPath, "utf8");
    files.push({
      path: filename,
      filename,
      title: basename(filename, ".md"),
      folder: null,
      content,
    });
  }

  for (const folder of folders) {
    const folderPath = join(contextDir, folder.name);
    const nested = await readdir(folderPath, { withFileTypes: true });
    const markdownInFolder = nested
      .filter((entry) => entry.isFile() && extname(entry.name).toLowerCase() === ".md")
      .map((entry) => entry.name)
      .sort((a, b) => a.localeCompare(b));

    for (const filename of markdownInFolder) {
      const fullPath = join(folderPath, filename);
      const content = await readFile(fullPath, "utf8");
      files.push({
        path: `${folder.name}/${filename}`,
        filename,
        title: basename(filename, ".md"),
        folder: folder.name,
        content,
      });
    }
  }

  return { folders, files };
}
