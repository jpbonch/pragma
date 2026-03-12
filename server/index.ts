import { randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
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
import {
  buildRepoDiffEntries,
  deleteJobWorktree,
  getJobMainOutputDir,
  mergeApprovedJob,
  parseJobGitState,
} from "./conversation/gitWorkflow";
import { resolveModelId } from "./conversation/models";
import { buildPrompt } from "./conversation/prompts";
import { resolveSalmonCliCommand } from "./conversation/salmonCli";
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
import { isJobStatus } from "./conversation/types";
import type { HarnessId, JobStatus, ReasoningEffort } from "./conversation/types";

type StartServerOptions = {
  port: number;
};

type JobStatusStreamEvent = {
  job_id: string;
  status: JobStatus;
  changed_at: string;
  source: string;
};

type JobStatusListener = (event: JobStatusStreamEvent) => void;

const JOB_STATUS_LISTENERS = new Map<string, Set<JobStatusListener>>();

function subscribeJobStatus(workspaceName: string, listener: JobStatusListener): () => void {
  const current = JOB_STATUS_LISTENERS.get(workspaceName);
  if (current) {
    current.add(listener);
  } else {
    JOB_STATUS_LISTENERS.set(workspaceName, new Set([listener]));
  }

  return () => {
    const listeners = JOB_STATUS_LISTENERS.get(workspaceName);
    if (!listeners) {
      return;
    }
    listeners.delete(listener);
    if (listeners.size === 0) {
      JOB_STATUS_LISTENERS.delete(workspaceName);
    }
  };
}

function publishJobStatus(workspaceName: string, event: JobStatusStreamEvent): void {
  const listeners = JOB_STATUS_LISTENERS.get(workspaceName);
  if (!listeners || listeners.size === 0) {
    return;
  }

  for (const listener of listeners) {
    listener(event);
  }
}

export async function startServer(options: StartServerOptions): Promise<void> {
  await setupSalmon();
  const apiUrl = process.env.SALMON_API_URL?.trim() || `http://127.0.0.1:${options.port}`;
  const salmonCliCommand = resolveSalmonCliCommand(__dirname);
  const executeRunner = new ExecuteRunner({
    apiUrl,
    salmonCliCommand,
    onJobStatusChanged: (input) => {
      publishJobStatus(input.workspaceName, {
        job_id: input.jobId,
        status: input.status,
        changed_at: new Date().toISOString(),
        source: input.source,
      });
    },
  });

  const app = new Hono();
  app.use("*", cors());
  const emitJobStatus = (
    workspaceName: string,
    jobId: string,
    status: JobStatus,
    source: string,
  ): void => {
    publishJobStatus(workspaceName, {
      job_id: jobId,
      status,
      changed_at: new Date().toISOString(),
      source,
    });
  };

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

    if (status && !isJobStatus(status)) {
      throw new SalmonError("INVALID_JOB_STATUS", 400, `Invalid job status: ${status}`);
    }

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
        status: JobStatus;
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

  app.get("/jobs/stream", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();

    c.header("cache-control", "no-store");
    c.header("connection", "keep-alive");

    return streamSSE(c, async (stream) => {
      let closed = false;
      const writeEvent = (eventName: string, payload: Record<string, unknown>): void => {
        if (closed) {
          return;
        }
        void stream.writeSSE({
          event: eventName,
          data: JSON.stringify(payload),
        }).catch(() => undefined);
      };

      writeEvent("ready", { workspace: workspaceName, ts: new Date().toISOString() });

      const unsubscribe = subscribeJobStatus(workspaceName, (event) => {
        writeEvent("job_status_changed", event);
      });

      const pingTimer = setInterval(() => {
        writeEvent("ping", { ts: new Date().toISOString() });
      }, 15000);

      const abortSignal = c.req.raw.signal;
      await new Promise<void>((resolve) => {
        const closeStream = () => resolve();
        if (abortSignal.aborted) {
          resolve();
          return;
        }
        abortSignal.addEventListener("abort", closeStream, { once: true });
      });

      closed = true;
      clearInterval(pingTimer);
      unsubscribe();
    });
  });

  app.get("/jobs/:jobId/output/changes", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const jobId = c.req.param("jobId");
    const db = await openDatabase(workspaceName);

    try {
      const jobResult = await db.query<{ id: string; git_state_json: string | null }>(
        `
SELECT id, git_state_json
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

      const gitState = parseJobGitState(job.git_state_json);
      if (!gitState) {
        throw new SalmonError(
          "JOB_GIT_STATE_MISSING",
          409,
          `Job has no git execution state: ${jobId}`,
        );
      }

      const workspacePaths = getWorkspacePaths(workspaceName);
      const repoDiffs = await buildRepoDiffEntries({
        workspacePaths,
        jobId,
        gitState,
      });

      const combinedDiff = repoDiffs
        .filter((entry) => entry.diff.trim().length > 0)
        .map((entry) => {
          if (repoDiffs.length === 1) {
            return entry.diff;
          }
          return `# repo: ${entry.repo_path}\n${entry.diff}`;
        })
        .join("\n\n");

      return c.json({
        roots: [join(workspacePaths.worktreesDir, jobId, "workspace")],
        repos: repoDiffs,
        diff: combinedDiff,
      });
    } finally {
      await db.close();
    }
  });

  app.get("/jobs/:jobId/output/files", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const jobId = c.req.param("jobId");
    const db = await openDatabase(workspaceName);

    try {
      const workspacePaths = getWorkspacePaths(workspaceName);
      const outputsRoot = await getJobOutputsRoot(db, workspacePaths, jobId);
      const files = await listOutputFiles(outputsRoot);

      return c.json({
        root: outputsRoot,
        files,
      });
    } finally {
      await db.close();
    }
  });

  app.get("/jobs/:jobId/output/file/content", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const jobId = c.req.param("jobId");
    const relativePath = c.req.query("path") ?? "";
    const db = await openDatabase(workspaceName);

    try {
      const workspacePaths = getWorkspacePaths(workspaceName);
      const outputsRoot = await getJobOutputsRoot(db, workspacePaths, jobId);
      const { absolutePath, normalizedPath } = resolveOutputPath(outputsRoot, relativePath);
      const fileInfo = await stat(absolutePath).catch(() => null);
      if (!fileInfo?.isFile()) {
        throw new SalmonError("OUTPUT_FILE_NOT_FOUND", 404, `Output file not found: ${normalizedPath}`);
      }

      const mime = inferMimeType(absolutePath);
      const content = await readFile(absolutePath);
      return c.body(content, 200, {
        "content-type": mime,
        "content-disposition": `inline; filename="${basename(absolutePath)}"`,
        "cache-control": "no-store",
      });
    } finally {
      await db.close();
    }
  });

  app.get("/jobs/:jobId/output/file/download", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const jobId = c.req.param("jobId");
    const relativePath = c.req.query("path") ?? "";
    const db = await openDatabase(workspaceName);

    try {
      const workspacePaths = getWorkspacePaths(workspaceName);
      const outputsRoot = await getJobOutputsRoot(db, workspacePaths, jobId);
      const { absolutePath, normalizedPath } = resolveOutputPath(outputsRoot, relativePath);
      const fileInfo = await stat(absolutePath).catch(() => null);
      if (!fileInfo?.isFile()) {
        throw new SalmonError("OUTPUT_FILE_NOT_FOUND", 404, `Output file not found: ${normalizedPath}`);
      }

      const mime = inferMimeType(absolutePath);
      const content = await readFile(absolutePath);
      return c.body(content, 200, {
        "content-type": mime,
        "content-disposition": `attachment; filename="${basename(absolutePath)}"`,
        "cache-control": "no-store",
      });
    } finally {
      await db.close();
    }
  });

  app.post("/jobs/:jobId/output/open-folder", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const jobId = c.req.param("jobId");

    let body: unknown = null;
    try {
      body = await c.req.json();
    } catch {
      body = null;
    }

    if (!isOpenOutputFolderBody(body)) {
      throw new SalmonError("INVALID_OPEN_FOLDER_BODY", 400, "Invalid open-folder request.");
    }

    const db = await openDatabase(workspaceName);
    try {
      const workspacePaths = getWorkspacePaths(workspaceName);
      const outputsRoot = await getJobOutputsRoot(db, workspacePaths, jobId);

      let targetPath = outputsRoot;
      if (body.path) {
        const { absolutePath } = resolveOutputPath(outputsRoot, body.path);
        const fileInfo = await stat(absolutePath).catch(() => null);
        if (!fileInfo) {
          throw new SalmonError("OUTPUT_PATH_NOT_FOUND", 404, "Output path does not exist.");
        }
        targetPath = fileInfo.isDirectory() ? absolutePath : dirname(absolutePath);
      }

      await openFolder(targetPath);
      return c.json({ ok: true, path: targetPath });
    } finally {
      await db.close();
    }
  });

  app.post("/jobs/:jobId/review", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const jobId = c.req.param("jobId");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new SalmonError("INVALID_JSON", 400, "Invalid JSON body.");
    }

    if (!isReviewJobBody(body)) {
      throw new SalmonError(
        "INVALID_REVIEW_ACTION",
        400,
        "`action` must be `approve`.",
      );
    }

    const db = await openDatabase(workspaceName);
    try {
      await ensureConversationSchema(db);

      const jobResult = await db.query<{
        id: string;
        status: JobStatus;
        assigned_to: string | null;
        merge_retry_count: number | null;
        git_state_json: string | null;
      }>(
        `
SELECT id, status, assigned_to, merge_retry_count, git_state_json
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
      if (job.status !== "pending_review") {
        throw new SalmonError(
          "JOB_NOT_PENDING_REVIEW",
          409,
          `Job is not pending review: ${jobId}`,
        );
      }

      const gitState = parseJobGitState(job.git_state_json);
      if (!gitState) {
        throw new SalmonError(
          "JOB_GIT_STATE_MISSING",
          409,
          `Job has no git execution state: ${jobId}`,
        );
      }

      const workspacePaths = getWorkspacePaths(workspaceName);
      const mergeResult = await mergeApprovedJob({
        workspacePaths,
        jobId,
        gitState,
      });

      if (mergeResult.conflicts.length === 0) {
        const nextStatus: JobStatus = "completed";
        const mergedOutputDir = getJobMainOutputDir(workspacePaths, jobId);
        await db.query(
          `
UPDATE jobs
SET status = $2,
    output_dir = $3
WHERE id = $1
`,
          [jobId, nextStatus, mergedOutputDir],
        );
        emitJobStatus(workspaceName, jobId, nextStatus, "review_action");
        let cleanupError = "";
        try {
          await deleteJobWorktree({ workspacePaths, jobId });
        } catch (error: unknown) {
          cleanupError = errorMessage(error);
        }
        return c.json({
          ok: true,
          status: nextStatus,
          merge_state: "merged",
          conflicts: [],
          worktree_cleanup_error: cleanupError || undefined,
        });
      }

      const retryCount = Number.isInteger(job.merge_retry_count) ? (job.merge_retry_count as number) : 0;
      if (retryCount < 1) {
        await db.query(
          `
UPDATE jobs
SET status = 'queued',
    merge_retry_count = COALESCE(merge_retry_count, 0) + 1
WHERE id = $1
`,
          [jobId],
        );
        emitJobStatus(workspaceName, jobId, "queued", "review_conflict_retry");

        const thread = await getThreadByJobId(db, jobId);
        const latestExecuteTurn = thread ? await getLatestExecuteTurn(db, thread.id) : null;
        if (thread && latestExecuteTurn && latestExecuteTurn.user_message.trim()) {
          const retryPrompt = buildConflictRetryPrompt({
            originalTask: latestExecuteTurn.user_message,
            conflicts: mergeResult.conflicts,
          });
          executeRunner.enqueue({
            workspaceName,
            jobId,
            threadId: thread.id,
            prompt: retryPrompt,
            requestedRecipientAgentId: job.assigned_to ?? undefined,
            reasoningEffort: latestExecuteTurn.reasoning_effort ?? "medium",
          });

          return c.json({
            ok: true,
            status: "queued",
            merge_state: "conflict_retry_enqueued",
            conflicts: mergeResult.conflicts,
          });
        }

        await db.query(
          `
UPDATE jobs
SET status = 'needs_fix'
WHERE id = $1
`,
          [jobId],
        );
        emitJobStatus(workspaceName, jobId, "needs_fix", "review_conflict_missing_retry_context");
        return c.json({
          ok: true,
          status: "needs_fix",
          merge_state: "manual_intervention_required",
          conflicts: mergeResult.conflicts,
        });
      }

      await db.query(
        `
UPDATE jobs
SET status = 'needs_fix'
WHERE id = $1
`,
        [jobId],
      );
      emitJobStatus(workspaceName, jobId, "needs_fix", "review_conflict_manual");
      return c.json({
        ok: true,
        status: "needs_fix",
        merge_state: "manual_intervention_required",
        conflicts: mergeResult.conflicts,
      });
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
    const status: JobStatus = body.status ?? "queued";
    if (!isJobStatus(status)) {
      throw new SalmonError("INVALID_JOB_STATUS", 400, `Invalid job status: ${body.status}`);
    }
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
          status,
          body.assigned_to ?? null,
          body.output_dir ?? null,
          body.session_id ?? null,
        ],
      );
      emitJobStatus(workspaceName, jobId, status, "job_created");
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
VALUES ($1, $2, 'queued', NULL, NULL, NULL)
`,
        [jobId, title || "Execute task"],
      );
      emitJobStatus(workspaceName, jobId, "queued", "execute_created");

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
      const jobResult = await db.query<{ id: string; status: JobStatus }>(
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
      if (job.status !== "waiting_for_recipient") {
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
SET status = 'queued'
WHERE id = $1
`,
        [jobId],
      );
      emitJobStatus(workspaceName, jobId, "queued", "recipient_selected");

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

  app.post("/jobs/:jobId/agent/select-recipient", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const jobId = c.req.param("jobId");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new SalmonError("INVALID_JSON", 400, "Invalid JSON body.");
    }

    if (!isAgentSelectRecipientBody(body)) {
      throw new SalmonError(
        "INVALID_AGENT_SELECT_RECIPIENT",
        400,
        "`agent_id` and `reason` are required.",
      );
    }

    const selectedAgentId = body.agent_id.trim();
    const db = await openDatabase(workspaceName);

    try {
      await ensureConversationSchema(db);
      const jobResult = await db.query<{ id: string; status: JobStatus }>(
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
      if (job.status !== "orchestrating") {
        throw new SalmonError(
          "JOB_NOT_ORCHESTRATING",
          409,
          `Job is not orchestrating: ${jobId}`,
        );
      }

      const recipient = await getAgentRow(db, selectedAgentId);
      if (!recipient || recipient.id === DEFAULT_AGENT_ID) {
        throw new SalmonError("INVALID_RECIPIENT", 400, `Invalid recipient agent id: ${selectedAgentId}`);
      }

      await db.query(
        `
UPDATE jobs
SET assigned_to = $2
WHERE id = $1
`,
        [jobId, selectedAgentId],
      );

      const thread = await getThreadByJobId(db, jobId);
      if (thread) {
        const latestExecuteTurn = await getLatestExecuteTurn(db, thread.id);
        await insertEvent(db, {
          id: `evt_${randomUUID().slice(0, 12)}`,
          threadId: thread.id,
          turnId: body.turn_id?.trim() || latestExecuteTurn?.id || null,
          eventName: "recipient_selected_via_cli",
          payload: {
            selected_agent_id: selectedAgentId,
            reason: body.reason.trim(),
            agent_turn_id: body.turn_id?.trim() || null,
          },
        });
      }
    } finally {
      await db.close();
    }

    return c.json({ ok: true, assigned_to: selectedAgentId });
  });

  app.post("/jobs/:jobId/agent/ask-question", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const jobId = c.req.param("jobId");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new SalmonError("INVALID_JSON", 400, "Invalid JSON body.");
    }

    if (!isAgentAskQuestionBody(body)) {
      throw new SalmonError(
        "INVALID_AGENT_ASK_QUESTION",
        400,
        "`question` is required.",
      );
    }

    const db = await openDatabase(workspaceName);
    try {
      await ensureConversationSchema(db);
      const jobResult = await db.query<{ id: string; status: JobStatus; assigned_to: string | null }>(
        `
SELECT id, status, assigned_to
FROM jobs
WHERE id = $1
LIMIT 1
`,
        [jobId],
      );
      emitJobStatus(workspaceName, jobId, "waiting_for_question_response", "worker_ask_question");
      const job = jobResult.rows[0];
      if (!job) {
        throw new SalmonError("JOB_NOT_FOUND", 404, `Job not found: ${jobId}`);
      }
      if (job.status !== "running") {
        throw new SalmonError("JOB_NOT_RUNNING", 409, `Job is not running: ${jobId}`);
      }

      await db.query(
        `
UPDATE jobs
SET status = 'waiting_for_question_response'
WHERE id = $1
`,
        [jobId],
      );
      emitJobStatus(workspaceName, jobId, "waiting_for_help_response", "worker_request_help");

      const thread = await getThreadByJobId(db, jobId);
      if (thread) {
        const latestExecuteTurn = await getLatestExecuteTurn(db, thread.id);
        await insertEvent(db, {
          id: `evt_${randomUUID().slice(0, 12)}`,
          threadId: thread.id,
          turnId: body.turn_id?.trim() || latestExecuteTurn?.id || null,
          eventName: "worker_question_requested",
          payload: {
            question: body.question.trim(),
            details: body.details?.trim() || null,
            agent_id: body.agent_id?.trim() || job.assigned_to || null,
          },
        });
      }

      return c.json({ ok: true, status: "waiting_for_question_response" });
    } finally {
      await db.close();
    }
  });

  app.post("/jobs/:jobId/agent/request-help", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const jobId = c.req.param("jobId");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new SalmonError("INVALID_JSON", 400, "Invalid JSON body.");
    }

    if (!isAgentRequestHelpBody(body)) {
      throw new SalmonError(
        "INVALID_AGENT_REQUEST_HELP",
        400,
        "`summary` is required.",
      );
    }

    const db = await openDatabase(workspaceName);
    try {
      await ensureConversationSchema(db);
      const jobResult = await db.query<{ id: string; status: JobStatus; assigned_to: string | null }>(
        `
SELECT id, status, assigned_to
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
      if (job.status !== "running") {
        throw new SalmonError("JOB_NOT_RUNNING", 409, `Job is not running: ${jobId}`);
      }

      await db.query(
        `
UPDATE jobs
SET status = 'waiting_for_help_response'
WHERE id = $1
`,
        [jobId],
      );
      emitJobStatus(workspaceName, jobId, "queued", "human_response");

      const thread = await getThreadByJobId(db, jobId);
      if (thread) {
        const latestExecuteTurn = await getLatestExecuteTurn(db, thread.id);
        await insertEvent(db, {
          id: `evt_${randomUUID().slice(0, 12)}`,
          threadId: thread.id,
          turnId: body.turn_id?.trim() || latestExecuteTurn?.id || null,
          eventName: "worker_help_requested",
          payload: {
            summary: body.summary.trim(),
            details: body.details?.trim() || null,
            agent_id: body.agent_id?.trim() || job.assigned_to || null,
          },
        });
      }

      return c.json({ ok: true, status: "waiting_for_help_response" });
    } finally {
      await db.close();
    }
  });

  app.post("/jobs/:jobId/respond", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const jobId = c.req.param("jobId");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new SalmonError("INVALID_JSON", 400, "Invalid JSON body.");
    }

    if (!isJobRespondBody(body)) {
      throw new SalmonError(
        "INVALID_JOB_RESPONSE",
        400,
        "`message` is required.",
      );
    }

    const db = await openDatabase(workspaceName);
    let requeue: {
      threadId: string;
      prompt: string;
      recipientAgentId: string;
      reasoningEffort: ReasoningEffort;
    } | null = null;

    try {
      await ensureConversationSchema(db);
      const jobResult = await db.query<{
        id: string;
        status: JobStatus;
        assigned_to: string | null;
      }>(
        `
SELECT id, status, assigned_to
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
      if (
        job.status !== "waiting_for_question_response" &&
        job.status !== "waiting_for_help_response"
      ) {
        throw new SalmonError(
          "JOB_NOT_WAITING_FOR_RESPONSE",
          409,
          `Job is not waiting for a human response: ${jobId}`,
        );
      }
      if (!job.assigned_to) {
        throw new SalmonError(
          "JOB_MISSING_ASSIGNED_WORKER",
          409,
          `Job has no assigned worker to resume: ${jobId}`,
        );
      }
      const resumeWorker = await getAgentRow(db, job.assigned_to);
      if (!resumeWorker || resumeWorker.id === DEFAULT_AGENT_ID) {
        throw new SalmonError(
          "JOB_INVALID_ASSIGNED_WORKER",
          409,
          `Assigned worker is invalid for resume: ${jobId}`,
        );
      }

      const thread = await getThreadByJobId(db, jobId);
      if (!thread) {
        throw new SalmonError("JOB_THREAD_NOT_FOUND", 404, `No conversation thread found for job: ${jobId}`);
      }

      const latestExecuteTurn = await getLatestExecuteTurn(db, thread.id);
      if (!latestExecuteTurn || !latestExecuteTurn.user_message.trim()) {
        throw new SalmonError("NO_EXECUTE_PROMPT", 409, "No execute task prompt is available for this job.");
      }

      await insertMessage(db, {
        id: `msg_${randomUUID().slice(0, 12)}`,
        threadId: thread.id,
        turnId: null,
        role: "user",
        content: body.message.trim(),
      });

      await insertEvent(db, {
        id: `evt_${randomUUID().slice(0, 12)}`,
        threadId: thread.id,
        turnId: latestExecuteTurn.id,
        eventName: "human_response_received",
        payload: {
          message: body.message.trim(),
          responded_to_status: job.status,
        },
      });

      await db.query(
        `
UPDATE jobs
SET status = 'queued'
WHERE id = $1
`,
        [jobId],
      );

      requeue = {
        threadId: thread.id,
        prompt: latestExecuteTurn.user_message,
        recipientAgentId: resumeWorker.id,
        reasoningEffort: latestExecuteTurn.reasoning_effort ?? "medium",
      };
    } finally {
      await db.close();
    }

    if (requeue) {
      executeRunner.enqueue({
        workspaceName,
        jobId,
        threadId: requeue.threadId,
        prompt: requeue.prompt,
        requestedRecipientAgentId: requeue.recipientAgentId,
        reasoningEffort: requeue.reasoningEffort,
      });
    }

    return c.json({ ok: true, status: "queued" });
  });

  app.post("/conversations/:threadId/turns/:turnId/agent/plan-summary", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const threadId = c.req.param("threadId");
    const turnId = c.req.param("turnId");

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new SalmonError("INVALID_JSON", 400, "Invalid JSON body.");
    }

    if (!isPlanSummarySubmissionBody(body)) {
      throw new SalmonError(
        "INVALID_PLAN_SUMMARY",
        400,
        "`title`, `summary`, and non-empty `steps` are required.",
      );
    }

    const db = await openDatabase(workspaceName);
    try {
      await ensureConversationSchema(db);

      const turnResult = await db.query<{
        id: string;
        thread_id: string;
        mode: "chat" | "plan" | "execute";
      }>(
        `
SELECT id, thread_id, mode
FROM conversation_turns
WHERE id = $1
  AND thread_id = $2
LIMIT 1
`,
        [turnId, threadId],
      );

      const turn = turnResult.rows[0];
      if (!turn) {
        throw new SalmonError(
          "TURN_NOT_FOUND",
          404,
          `Conversation turn not found: ${turnId}`,
        );
      }
      if (turn.mode !== "plan") {
        throw new SalmonError(
          "TURN_NOT_PLAN_MODE",
          409,
          `Turn is not in plan mode: ${turnId}`,
        );
      }

      const normalized = normalizePlanSummary(body);
      await db.query(
        `
UPDATE conversation_turns
SET plan_summary = $2
WHERE id = $1
`,
        [turnId, JSON.stringify(normalized)],
      );

      await insertEvent(db, {
        id: `evt_${randomUUID().slice(0, 12)}`,
        threadId,
        turnId,
        eventName: "plan_summary_submitted",
        payload: {
          source: "cli",
          title: normalized.title,
          summary: normalized.summary,
          steps_count: normalized.steps.length,
        },
      });

      return c.json({ ok: true });
    } finally {
      await db.close();
    }
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
          prompt: buildPrompt(body.mode, message, reasoningEffort, salmonCliCommand),
          modelId,
          sessionId: thread.harness_session_id,
          cwd: paths.codeDir,
          env: buildConversationAgentEnv({
            apiUrl,
            salmonCliCommand,
            workspaceName,
            threadId,
            turnId,
            agentId: DEFAULT_AGENT_ID,
            jobId: thread.job_id,
          }),
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
        const declaredPlanSummary =
          body.mode === "plan" ? await getStoredPlanSummaryForTurn(db, turnId) : null;
        const planSummarySubmissionCount =
          body.mode === "plan" ? await countPlanSummarySubmissionsForTurn(db, turnId) : 0;
        if (
          body.mode === "plan" &&
          (!declaredPlanSummary || planSummarySubmissionCount !== 1)
        ) {
          throw new SalmonError(
            "PLAN_SUMMARY_REQUIRED",
            409,
            "Plan mode requires exactly one `salmon job plan-summary` CLI submission.",
          );
        }
        const planSummary = body.mode === "plan" ? declaredPlanSummary : null;

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
VALUES ($1, $2, 'queued', NULL, NULL, NULL)
`,
        [jobId, planTitle],
      );
      emitJobStatus(workspaceName, jobId, "queued", "execute_from_plan_created");

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
  status?: JobStatus;
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

type AgentSelectRecipientBody = {
  agent_id: string;
  reason: string;
  turn_id?: string;
};

type AgentAskQuestionBody = {
  question: string;
  details?: string;
  turn_id?: string;
  agent_id?: string;
};

type AgentRequestHelpBody = {
  summary: string;
  details?: string;
  turn_id?: string;
  agent_id?: string;
};

type JobRespondBody = {
  message: string;
};

type PlanSummarySubmissionBody = {
  title: string;
  summary: string;
  steps: string[];
};

type ReviewJobBody = {
  action: "approve";
};

type OpenOutputFolderBody = {
  path?: string;
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

  if (body.status !== undefined && !isJobStatus(body.status)) {
    return false;
  }

  const optionalStringFields = ["assigned_to", "output_dir", "session_id"] as const;

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

function isAgentSelectRecipientBody(value: unknown): value is AgentSelectRecipientBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const body = value as Record<string, unknown>;
  if (typeof body.agent_id !== "string" || body.agent_id.trim().length === 0) {
    return false;
  }
  if (typeof body.reason !== "string" || body.reason.trim().length === 0) {
    return false;
  }
  if (body.turn_id !== undefined && typeof body.turn_id !== "string") {
    return false;
  }
  return true;
}

function isAgentAskQuestionBody(value: unknown): value is AgentAskQuestionBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const body = value as Record<string, unknown>;
  if (typeof body.question !== "string" || body.question.trim().length === 0) {
    return false;
  }
  if (body.details !== undefined && typeof body.details !== "string") {
    return false;
  }
  if (body.turn_id !== undefined && typeof body.turn_id !== "string") {
    return false;
  }
  if (body.agent_id !== undefined && typeof body.agent_id !== "string") {
    return false;
  }
  return true;
}

function isAgentRequestHelpBody(value: unknown): value is AgentRequestHelpBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const body = value as Record<string, unknown>;
  if (typeof body.summary !== "string" || body.summary.trim().length === 0) {
    return false;
  }
  if (body.details !== undefined && typeof body.details !== "string") {
    return false;
  }
  if (body.turn_id !== undefined && typeof body.turn_id !== "string") {
    return false;
  }
  if (body.agent_id !== undefined && typeof body.agent_id !== "string") {
    return false;
  }
  return true;
}

function isJobRespondBody(value: unknown): value is JobRespondBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const body = value as Record<string, unknown>;
  return typeof body.message === "string" && body.message.trim().length > 0;
}

function isPlanSummarySubmissionBody(value: unknown): value is PlanSummarySubmissionBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const body = value as Record<string, unknown>;
  if (typeof body.title !== "string" || body.title.trim().length === 0) {
    return false;
  }
  if (typeof body.summary !== "string" || body.summary.trim().length === 0) {
    return false;
  }
  if (!Array.isArray(body.steps) || body.steps.length === 0) {
    return false;
  }
  if (!body.steps.every((step) => typeof step === "string" && step.trim().length > 0)) {
    return false;
  }

  return true;
}

function isReviewJobBody(value: unknown): value is ReviewJobBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const body = value as Record<string, unknown>;
  return body.action === "approve";
}

function isOpenOutputFolderBody(value: unknown): value is OpenOutputFolderBody {
  if (value === null || value === undefined) {
    return true;
  }
  if (typeof value !== "object") {
    return false;
  }

  const body = value as Record<string, unknown>;
  if (body.path === undefined) {
    return true;
  }
  return typeof body.path === "string";
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

function normalizePlanSummary(input: PlanSummarySubmissionBody): {
  title: string;
  summary: string;
  steps: string[];
} {
  return {
    title: input.title.trim(),
    summary: input.summary.trim(),
    steps: input.steps.map((step) => step.trim()).filter(Boolean),
  };
}

async function getStoredPlanSummaryForTurn(
  db: Awaited<ReturnType<typeof openDatabase>>,
  turnId: string,
): Promise<{ title: string; summary: string; steps: string[] } | null> {
  const result = await db.query<{ plan_summary: string | null }>(
    `
SELECT plan_summary
FROM conversation_turns
WHERE id = $1
LIMIT 1
`,
    [turnId],
  );

  const raw = result.rows[0]?.plan_summary;
  if (!raw) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (!isPlanSummaryRecord(parsed)) {
    return null;
  }

  return normalizePlanSummary(parsed);
}

async function countPlanSummarySubmissionsForTurn(
  db: Awaited<ReturnType<typeof openDatabase>>,
  turnId: string,
): Promise<number> {
  const result = await db.query<{ count: number }>(
    `
SELECT COUNT(*)::int AS count
FROM conversation_events
WHERE turn_id = $1
  AND event_name = 'plan_summary_submitted'
`,
    [turnId],
  );
  return result.rows[0]?.count ?? 0;
}

function isPlanSummaryRecord(value: unknown): value is PlanSummarySubmissionBody {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const record = value as Record<string, unknown>;
  return (
    typeof record.title === "string" &&
    typeof record.summary === "string" &&
    Array.isArray(record.steps) &&
    record.steps.every((step) => typeof step === "string")
  );
}

function buildConversationAgentEnv(input: {
  apiUrl: string;
  salmonCliCommand: string;
  workspaceName: string;
  threadId: string;
  turnId: string;
  agentId: string;
  jobId?: string | null;
}): Record<string, string> {
  const env: Record<string, string> = {
    SALMON_API_URL: input.apiUrl,
    SALMON_CLI_COMMAND: input.salmonCliCommand,
    SALMON_WORKSPACE_NAME: input.workspaceName,
    SALMON_THREAD_ID: input.threadId,
    SALMON_TURN_ID: input.turnId,
    SALMON_AGENT_ID: input.agentId,
  };

  if (input.jobId && input.jobId.trim()) {
    env.SALMON_JOB_ID = input.jobId;
  }

  return env;
}

function buildConflictRetryPrompt(input: {
  originalTask: string;
  conflicts: Array<{ repo_path: string; files: string[] }>;
}): string {
  const conflictLines = input.conflicts
    .map((conflict, index) => {
      const files =
        conflict.files.length > 0
          ? conflict.files.map((file) => `  - ${file}`).join("\n")
          : "  - (git reported conflict without explicit file list)";
      return `${index + 1}. repo: ${conflict.repo_path}\n${files}`;
    })
    .join("\n");

  return [
    "The previous approval merge reported conflicts.",
    "Resolve all merge conflicts in the current job worktrees, then finish with a clean summary for review.",
    "Conflict details:",
    conflictLines || "(none reported)",
    "Requirements:",
    "- Keep prior successful work intact.",
    "- Resolve conflict markers and ensure files are consistent.",
    "- Leave the workspace ready for a new approval review.",
    "Original task:",
    input.originalTask.trim(),
  ].join("\n\n");
}

async function getJobOutputsRoot(
  db: Awaited<ReturnType<typeof openDatabase>>,
  workspacePaths: ReturnType<typeof getWorkspacePaths>,
  jobId: string,
): Promise<string> {
  const result = await db.query<{ id: string; output_dir: string | null }>(
    `
SELECT id, output_dir
FROM jobs
WHERE id = $1
LIMIT 1
`,
    [jobId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new SalmonError("JOB_NOT_FOUND", 404, `Job not found: ${jobId}`);
  }

  return resolveJobOutputsRoot(workspacePaths, jobId, row.output_dir);
}

async function resolveJobOutputsRoot(
  workspacePaths: ReturnType<typeof getWorkspacePaths>,
  jobId: string,
  storedOutputDir?: string | null,
): Promise<string> {
  const mainRoot = resolve(join(workspacePaths.outputsDir, jobId));
  const worktreeRoot = resolve(
    join(workspacePaths.worktreesDir, jobId, "workspace", "outputs", jobId),
  );

  const preferred =
    typeof storedOutputDir === "string" && storedOutputDir.trim().length > 0
      ? storedOutputDir.trim()
      : "";
  if (preferred) {
    const absolute = resolve(preferred);
    if (isWithinRoot(mainRoot, absolute) || isWithinRoot(worktreeRoot, absolute)) {
      return absolute;
    }
  }

  if (await isDirectory(worktreeRoot)) {
    return worktreeRoot;
  }

  return mainRoot;
}

async function listOutputFiles(
  outputsRoot: string,
): Promise<Array<{ path: string; size: number; modified_at: string }>> {
  if (!(await isDirectory(outputsRoot))) {
    return [];
  }

  const files: Array<{ path: string; size: number; modified_at: string }> = [];
  await walkOutputFiles(outputsRoot, outputsRoot, files, { count: 0 }, 0);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return files;
}

async function walkOutputFiles(
  rootDir: string,
  currentDir: string,
  files: Array<{ path: string; size: number; modified_at: string }>,
  state: { count: number },
  depth: number,
): Promise<void> {
  if (depth > 12 || state.count > 5000) {
    return;
  }

  const entries = await readdir(currentDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    if (entry.name === "events.jsonl") {
      continue;
    }

    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkOutputFiles(rootDir, fullPath, files, state, depth + 1);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const fileInfo = await stat(fullPath).catch(() => null);
    if (!fileInfo?.isFile()) {
      continue;
    }

    const relPath = relative(rootDir, fullPath).split(sep).join("/");
    files.push({
      path: relPath,
      size: fileInfo.size,
      modified_at: fileInfo.mtime.toISOString(),
    });
    state.count += 1;
  }
}

function resolveOutputPath(
  outputsRoot: string,
  requestedPath: string,
): { absolutePath: string; normalizedPath: string } {
  const value = requestedPath.trim();
  if (!value) {
    throw new SalmonError("INVALID_OUTPUT_PATH", 400, "Output path is required.");
  }
  if (value.includes("\0")) {
    throw new SalmonError("INVALID_OUTPUT_PATH", 400, "Output path is invalid.");
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new SalmonError("INVALID_OUTPUT_PATH", 400, "Output path must be relative.");
  }

  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw new SalmonError("INVALID_OUTPUT_PATH", 400, "Output path is invalid.");
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new SalmonError("INVALID_OUTPUT_PATH", 400, "Output path cannot traverse directories.");
  }

  const normalizedPath = segments.join("/");
  const root = resolve(outputsRoot);
  const absolutePath = resolve(root, normalizedPath);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
    throw new SalmonError("INVALID_OUTPUT_PATH", 400, "Output path is out of bounds.");
  }

  return { absolutePath, normalizedPath };
}

function isWithinRoot(root: string, candidate: string): boolean {
  const normalizedRoot = resolve(root);
  const normalizedCandidate = resolve(candidate);
  return (
    normalizedCandidate === normalizedRoot ||
    normalizedCandidate.startsWith(`${normalizedRoot}${sep}`)
  );
}

function inferMimeType(path: string): string {
  const extension = extname(path).toLowerCase();
  if (extension === ".md") {
    return "text/markdown; charset=utf-8";
  }
  if (extension === ".html" || extension === ".htm") {
    return "text/html; charset=utf-8";
  }
  if (extension === ".txt" || extension === ".diff" || extension === ".patch") {
    return "text/plain; charset=utf-8";
  }
  if (extension === ".json") {
    return "application/json; charset=utf-8";
  }
  if (extension === ".csv") {
    return "text/csv; charset=utf-8";
  }
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".gif") {
    return "image/gif";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  if (extension === ".svg") {
    return "image/svg+xml";
  }
  return "application/octet-stream";
}

async function openFolder(targetPath: string): Promise<void> {
  const fullPath = resolve(targetPath);
  const fileInfo = await stat(fullPath).catch(() => null);
  if (!fileInfo) {
    throw new SalmonError("OUTPUT_PATH_NOT_FOUND", 404, "Path does not exist.");
  }

  const command =
    process.platform === "darwin"
      ? { command: "open", args: [fullPath] }
      : process.platform === "win32"
        ? { command: "explorer", args: [fullPath] }
        : { command: "xdg-open", args: [fullPath] };

  await new Promise<void>((resolvePromise, reject) => {
    const child = spawn(command.command, command.args, {
      detached: true,
      stdio: "ignore",
      env: process.env,
    });

    child.once("error", (error) => {
      reject(new SalmonError("OPEN_FOLDER_FAILED", 400, errorMessage(error)));
    });
    child.unref();
    resolvePromise();
  });
}

async function isDirectory(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return Boolean(info?.isDirectory());
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
