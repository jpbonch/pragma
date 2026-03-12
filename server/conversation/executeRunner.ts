import { randomUUID } from "node:crypto";
import { appendFile, cp, mkdir, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_AGENT_ID, getWorkspacePaths, openDatabase } from "../db";
import { getConversationAdapter } from "./adapters";
import { buildOrchestratorPrompt, buildWorkerPrompt } from "./prompts";
import { InProcessQueue } from "./queue";
import {
  closeThread,
  completeTurn,
  createTurn,
  failTurn,
  insertEvent,
  insertMessage,
  updateThreadSession,
} from "./store";
import type { HarnessId, JobStatus, ReasoningEffort } from "./types";

type EnqueueExecuteInput = {
  workspaceName: string;
  jobId: string;
  threadId: string;
  prompt: string;
  requestedRecipientAgentId?: string | null;
  reasoningEffort?: ReasoningEffort;
};

type AgentRow = {
  id: string;
  name: string;
  agent_file: string | null;
  harness: HarnessId;
  model_label: string;
  model_id: string;
};

type JobStatusChangedInput = {
  workspaceName: string;
  jobId: string;
  status: JobStatus;
  source: string;
};

export class ExecuteRunner {
  private readonly queue = new InProcessQueue();
  private readonly apiUrl: string;
  private readonly onJobStatusChanged?: (input: JobStatusChangedInput) => void | Promise<void>;

  constructor(options: {
    apiUrl: string;
    onJobStatusChanged?: (input: JobStatusChangedInput) => void | Promise<void>;
  }) {
    this.apiUrl = options.apiUrl;
    this.onJobStatusChanged = options.onJobStatusChanged;
  }

  enqueue(input: EnqueueExecuteInput): void {
    this.queue.enqueue(async () => {
      await runExecuteTask(input, {
        apiUrl: this.apiUrl,
        onJobStatusChanged: this.onJobStatusChanged,
      });
    });
  }
}

async function runExecuteTask(
  input: EnqueueExecuteInput,
  options: {
    apiUrl: string;
    onJobStatusChanged?: (input: JobStatusChangedInput) => void | Promise<void>;
  },
): Promise<void> {
  const db = await openDatabase(input.workspaceName);
  const paths = getWorkspacePaths(input.workspaceName);

  const jobRootDir = join(paths.worktreesDir, input.jobId);
  const jobCodeDir = join(jobRootDir, "code");
  const outputDir = join(jobRootDir, "outputs");
  const logFile = join(outputDir, "events.jsonl");
  await mkdir(jobRootDir, { recursive: true });
  await ensureJobCodeDir(paths.codeDir, jobCodeDir);
  await mkdir(outputDir, { recursive: true });

  const turnId = `turn_${randomUUID().slice(0, 12)}`;
  const userMessageId = `msg_${randomUUID().slice(0, 12)}`;
  const task = input.prompt.trim();
  const reasoningEffort = input.reasoningEffort ?? "medium";
  const notifyJobStatus = async (status: JobStatus, source: string): Promise<void> => {
    try {
      await options.onJobStatusChanged?.({
        workspaceName: input.workspaceName,
        jobId: input.jobId,
        status,
        source,
      });
    } catch {
      // Status streaming should not break execution flow.
    }
  };

  await db.query(
    `
UPDATE jobs
SET status = 'orchestrating',
    output_dir = $2,
    assigned_to = NULL
WHERE id = $1
`,
    [input.jobId, outputDir],
  );
  await notifyJobStatus("orchestrating", "execute_runner");

  try {
    const orchestrator = await getAgentById(db, DEFAULT_AGENT_ID);
    if (!orchestrator) {
      throw new Error(`Missing orchestrator agent: ${DEFAULT_AGENT_ID}`);
    }

    const workers = await listWorkerAgents(db, orchestrator.id);
    const requestedRecipientId = input.requestedRecipientAgentId?.trim() || null;

    let requestedWorker: AgentRow | null = null;
    if (requestedRecipientId) {
      requestedWorker = workers.find((worker) => worker.id === requestedRecipientId) ?? null;
      if (!requestedWorker) {
        throw new Error(`Requested recipient agent is invalid: ${requestedRecipientId}`);
      }
    }

    await createTurn(db, {
      id: turnId,
      threadId: input.threadId,
      mode: "execute",
      userMessage: task,
      reasoningEffort,
      requestedRecipientAgentId: requestedRecipientId,
      orchestratorAgentId: orchestrator.id,
    });

    await insertMessage(db, {
      id: userMessageId,
      threadId: input.threadId,
      turnId,
      role: "user",
      content: task,
    });

    if (requestedRecipientId) {
      await insertEvent(db, {
        id: `evt_${randomUUID().slice(0, 12)}`,
        threadId: input.threadId,
        turnId,
        eventName: "recipient_requested",
        payload: { recipient_agent_id: requestedRecipientId },
      });
    }

    await insertEvent(db, {
      id: `evt_${randomUUID().slice(0, 12)}`,
      threadId: input.threadId,
      turnId,
      eventName: "orchestrator_started",
      payload: {
        job_id: input.jobId,
        orchestrator_agent_id: orchestrator.id,
        harness: orchestrator.harness,
        model_label: orchestrator.model_label,
        model_id: orchestrator.model_id,
        reasoning_effort: reasoningEffort,
      },
    });

    await appendJsonLine(logFile, {
      type: "orchestrator_started",
      job_id: input.jobId,
      thread_id: input.threadId,
      turn_id: turnId,
      orchestrator_agent_id: orchestrator.id,
    });

    const orchestratorPrompt = buildOrchestratorPrompt({
      task,
      candidates: workers.map((worker) => ({
        id: worker.id,
        name: worker.name,
        harness: worker.harness,
        modelLabel: worker.model_label,
      })),
      forcedRecipientAgentId: requestedRecipientId,
      reasoningEffort,
    });

    const orchestratorAdapter = getConversationAdapter(orchestrator.harness);
    let orchestratorText = "";

    const orchestratorResult = await orchestratorAdapter.sendTurn({
      prompt: orchestratorPrompt,
      modelId: orchestrator.model_id,
      sessionId: null,
      cwd: jobCodeDir,
      env: buildAgentRuntimeEnv({
        apiUrl: options.apiUrl,
        workspaceName: input.workspaceName,
        jobId: input.jobId,
        threadId: input.threadId,
        turnId,
        agentId: orchestrator.id,
      }),
      mode: "execute",
      reasoningEffort,
      onEvent: async (event) => {
        await appendJsonLine(logFile, {
          phase: "orchestrator",
          ...event,
        });

        if (event.type === "assistant_text") {
          orchestratorText = appendText(orchestratorText, event.delta);
          return;
        }

        await insertEvent(db, {
          id: `evt_${randomUUID().slice(0, 12)}`,
          threadId: input.threadId,
          turnId,
          eventName: "tool_event",
          payload: event,
        });
      },
    });

    const finalOrchestratorText = (orchestratorResult.finalText || orchestratorText || "").trim();

    await updateThreadSession(db, {
      threadId: input.threadId,
      sessionId: orchestratorResult.sessionId,
    });

    let selectedWorker: AgentRow | null = null;
    let selectionStatus: "auto_selected" | "manual_selected" | "recipient_required" | "invalid" =
      "recipient_required";
    let selectionReason = "";

    if (requestedWorker) {
      selectedWorker = requestedWorker;
      selectionStatus = "manual_selected";
      selectionReason = "Manual recipient override.";
    } else {
      const selectedRecipientId = await getJobAssignedRecipientId(db, input.jobId);
      if (selectedRecipientId) {
        const match = workers.find((worker) => worker.id === selectedRecipientId) ?? null;
        if (!match) {
          selectionStatus = "invalid";
          selectionReason = `Orchestrator selected invalid worker id: ${selectedRecipientId}`;
        } else {
          selectedWorker = match;
          selectionStatus = "auto_selected";
          selectionReason = finalOrchestratorText || "Recipient selected via CLI.";
        }
      }
    }

    if (!selectedWorker) {
      const unresolvedStatus = selectionStatus === "invalid" ? "invalid" : "recipient_required";
      const reason =
        workers.length === 0
          ? "No eligible worker agents exist."
          : selectionReason || "Unable to resolve worker recipient.";

      await completeTurn(db, {
        turnId,
        assistantMessage: finalOrchestratorText || "Recipient selection requires input.",
        planSummary: null,
        selectionStatus: unresolvedStatus,
      });

      await insertMessage(db, {
        id: `msg_${randomUUID().slice(0, 12)}`,
        threadId: input.threadId,
        turnId,
        role: "assistant",
        content: finalOrchestratorText || "Recipient selection requires input.",
      });

      await insertEvent(db, {
        id: `evt_${randomUUID().slice(0, 12)}`,
        threadId: input.threadId,
        turnId,
        eventName: "recipient_required",
        payload: {
          reason,
          selection_status: unresolvedStatus,
          requested_recipient_agent_id: requestedRecipientId,
          candidates: workers.map((worker) => ({
            id: worker.id,
            name: worker.name,
            harness: worker.harness,
            model_label: worker.model_label,
          })),
        },
      });

      await db.query(
        `
UPDATE jobs
SET status = 'waiting_for_recipient',
    assigned_to = NULL,
    session_id = $2
WHERE id = $1
`,
        [input.jobId, orchestratorResult.sessionId],
      );
      await notifyJobStatus("waiting_for_recipient", "execute_runner");

      await appendJsonLine(logFile, {
        type: "recipient_required",
        reason,
      });
      return;
    }

    await insertEvent(db, {
      id: `evt_${randomUUID().slice(0, 12)}`,
      threadId: input.threadId,
      turnId,
      eventName: "recipient_selected",
      payload: {
        selected_agent_id: selectedWorker.id,
        selection_status: selectionStatus,
        reason: selectionReason,
      },
    });

    await db.query(
      `
UPDATE jobs
SET assigned_to = $2,
    status = 'running'
WHERE id = $1
`,
      [input.jobId, selectedWorker.id],
    );
    await notifyJobStatus("running", "execute_runner");

    await insertEvent(db, {
      id: `evt_${randomUUID().slice(0, 12)}`,
      threadId: input.threadId,
      turnId,
      eventName: "worker_started",
      payload: {
        worker_agent_id: selectedWorker.id,
        harness: selectedWorker.harness,
        model_label: selectedWorker.model_label,
        model_id: selectedWorker.model_id,
      },
    });

    const workerAdapter = getConversationAdapter(selectedWorker.harness);
    const workerPrompt = buildWorkerPrompt({
      task,
      workerName: selectedWorker.name,
      workerAgentFile: selectedWorker.agent_file ?? "",
      reasoningEffort,
    });

    let workerText = "";
    const workerResult = await workerAdapter.sendTurn({
      prompt: workerPrompt,
      modelId: selectedWorker.model_id,
      sessionId: null,
      cwd: jobCodeDir,
      env: buildAgentRuntimeEnv({
        apiUrl: options.apiUrl,
        workspaceName: input.workspaceName,
        jobId: input.jobId,
        threadId: input.threadId,
        turnId,
        agentId: selectedWorker.id,
      }),
      mode: "execute",
      reasoningEffort,
      onEvent: async (event) => {
        await appendJsonLine(logFile, {
          phase: "worker",
          ...event,
        });

        if (event.type === "assistant_text") {
          workerText = appendText(workerText, event.delta);
          await insertEvent(db, {
            id: `evt_${randomUUID().slice(0, 12)}`,
            threadId: input.threadId,
            turnId,
            eventName: "worker_text",
            payload: {
              delta: event.delta,
            },
          });
          return;
        }

        await insertEvent(db, {
          id: `evt_${randomUUID().slice(0, 12)}`,
          threadId: input.threadId,
          turnId,
          eventName: "worker_tool_event",
          payload: event,
        });
      },
    });

    const finalWorkerText = (workerResult.finalText || workerText || "").trim();
    const assistantMessageId = `msg_${randomUUID().slice(0, 12)}`;

    await completeTurn(db, {
      turnId,
      assistantMessage: finalWorkerText,
      planSummary: null,
      selectedAgentId: selectedWorker.id,
      workerSessionId: workerResult.sessionId,
      selectionStatus,
    });

    await insertMessage(db, {
      id: assistantMessageId,
      threadId: input.threadId,
      turnId,
      role: "assistant",
      content: finalWorkerText,
    });

    await insertEvent(db, {
      id: `evt_${randomUUID().slice(0, 12)}`,
      threadId: input.threadId,
      turnId,
      eventName: "worker_completed",
      payload: {
        turn_id: turnId,
        assistant_message_id: assistantMessageId,
        selected_agent_id: selectedWorker.id,
        worker_session_id: workerResult.sessionId,
      },
    });

    await closeThread(db, input.threadId);
    const statusResult = await db.query<{ status: JobStatus }>(
      `
SELECT status
FROM jobs
WHERE id = $1
LIMIT 1
`,
      [input.jobId],
    );

    const currentStatus = statusResult.rows[0]?.status ?? null;
    if (!isWaitingForHumanResponseStatus(currentStatus)) {
      await db.query(
        `
UPDATE jobs
SET status = 'pending_review',
    session_id = $2
WHERE id = $1
`,
        [input.jobId, workerResult.sessionId],
      );
      await notifyJobStatus("pending_review", "execute_runner");
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    await failTurn(db, turnId, message).catch(() => undefined);

    await insertEvent(db, {
      id: `evt_${randomUUID().slice(0, 12)}`,
      threadId: input.threadId,
      turnId,
      eventName: "error",
      payload: { message },
    }).catch(() => undefined);

    await closeThread(db, input.threadId).catch(() => undefined);

    await db.query(
      `
UPDATE jobs
SET status = 'failed'
WHERE id = $1
`,
      [input.jobId],
    ).catch(() => undefined);
    await notifyJobStatus("failed", "execute_runner");

    await appendJsonLine(logFile, { type: "error", message });
  } finally {
    await db.close();
  }
}

async function getAgentById(
  db: Awaited<ReturnType<typeof openDatabase>>,
  id: string,
): Promise<AgentRow | null> {
  const result = await db.query<AgentRow>(
    `
SELECT id, name, agent_file, harness, model_label, model_id
FROM agents
WHERE id = $1
LIMIT 1
`,
    [id],
  );

  return result.rows[0] ?? null;
}

async function listWorkerAgents(
  db: Awaited<ReturnType<typeof openDatabase>>,
  orchestratorId: string,
): Promise<AgentRow[]> {
  const result = await db.query<AgentRow>(
    `
SELECT id, name, agent_file, harness, model_label, model_id
FROM agents
WHERE id <> $1
ORDER BY name ASC
`,
    [orchestratorId],
  );

  return result.rows;
}

async function getJobAssignedRecipientId(
  db: Awaited<ReturnType<typeof openDatabase>>,
  jobId: string,
): Promise<string | null> {
  const result = await db.query<{ assigned_to: string | null }>(
    `
SELECT assigned_to
FROM jobs
WHERE id = $1
LIMIT 1
`,
    [jobId],
  );

  return result.rows[0]?.assigned_to ?? null;
}

function buildAgentRuntimeEnv(input: {
  apiUrl: string;
  workspaceName: string;
  jobId: string;
  threadId: string;
  turnId: string;
  agentId: string;
}): Record<string, string> {
  return {
    SALMON_API_URL: input.apiUrl,
    SALMON_WORKSPACE_NAME: input.workspaceName,
    SALMON_JOB_ID: input.jobId,
    SALMON_THREAD_ID: input.threadId,
    SALMON_TURN_ID: input.turnId,
    SALMON_AGENT_ID: input.agentId,
  };
}

function isWaitingForHumanResponseStatus(status: JobStatus | null): boolean {
  return status === "waiting_for_question_response" || status === "waiting_for_help_response";
}

async function appendJsonLine(filePath: string, payload: unknown): Promise<void> {
  await appendFile(filePath, `${JSON.stringify(payload)}\n`, "utf8");
}

function appendText(current: string, next: string): string {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  return `${current}\n${next}`;
}

async function ensureJobCodeDir(sourceCodeDir: string, targetCodeDir: string): Promise<void> {
  await mkdir(targetCodeDir, { recursive: true });

  const targetEntries = await readdir(targetCodeDir).catch(() => []);
  if (targetEntries.length > 0) {
    return;
  }

  const sourceStat = await stat(sourceCodeDir).catch(() => null);
  if (!sourceStat?.isDirectory()) {
    return;
  }

  const sourceEntries = await readdir(sourceCodeDir).catch(() => []);
  if (sourceEntries.length === 0) {
    return;
  }

  await Promise.all(
    sourceEntries.map((entry) =>
      cp(join(sourceCodeDir, entry), join(targetCodeDir, entry), {
        recursive: true,
        force: true,
      }),
    ),
  );
}
