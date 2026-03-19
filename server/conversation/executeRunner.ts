import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { DEFAULT_AGENT_ID, getWorkspacePaths, openDatabase } from "../db";
import { getConnectorBinDir } from "../connectorBinaries";
import { CONNECTOR_REGISTRY, OAUTH_PROXY_URL } from "../connectorRegistry";
import { getConversationAdapter } from "./adapters";
import {
  checkpointTaskRepos,
  deleteTaskWorktree,
  getTaskMainOutputDir,
  mergeApprovedTask,
  parseTaskGitState,
  prepareTaskWorkspace,
  saveDiffSnapshot,
  serializeTaskGitState,
} from "./gitWorkflow";
import type { TaskGitState } from "./gitWorkflow";
import { runCommand } from "../process/runCommand";
import { buildConversationHistoryBlock, buildOrchestratorPrompt, buildWorkerPrompt } from "./prompts";
import {
  closeThread,
  completeTurn,
  createTurn,
  failTurn,
  getFirstExecuteTurn,
  getThreadByTaskId,
  getThreadMessages,
  insertEvent,
  insertMessage,
  reopenThread,
  updateThreadSession,
} from "./store";
import type { HarnessId, TaskStatus, ReasoningEffort } from "./types";

type EnqueueExecuteInput = {
  workspaceName: string;
  taskId: string;
  threadId: string;
  prompt: string;
  requestedRecipientAgentId?: string | null;
  reasoningEffort: ReasoningEffort;
  skipOrchestratorSelection?: boolean;
  resumeWorkerSessionId?: string | null;
  followUpMessage?: string | null;
};

type AgentRow = {
  id: string;
  name: string;
  description: string | null;
  agent_file: string | null;
  harness: HarnessId;
  model_label: string;
  model_id: string;
};

type TaskStatusChangedInput = {
  workspaceName: string;
  taskId: string;
  threadId: string;
  status: TaskStatus;
  source: string;
};

type ThreadUpdatedInput = {
  workspaceName: string;
  threadId: string;
  source: string;
};

// Active AbortControllers keyed by taskId, so we can cancel in-progress executions
const ACTIVE_TASK_ABORTS = new Map<string, AbortController>();

export class ExecuteRunner {
  private readonly apiUrl: string;
  private readonly pragmaCliCommand: string;
  private readonly onTaskStatusChanged?: (input: TaskStatusChangedInput) => void | Promise<void>;
  private readonly onThreadUpdated?: (input: ThreadUpdatedInput) => void | Promise<void>;

  constructor(options: {
    apiUrl: string;
    pragmaCliCommand: string;
    onTaskStatusChanged?: (input: TaskStatusChangedInput) => void | Promise<void>;
    onThreadUpdated?: (input: ThreadUpdatedInput) => void | Promise<void>;
  }) {
    this.apiUrl = options.apiUrl;
    this.pragmaCliCommand = options.pragmaCliCommand;
    this.onTaskStatusChanged = options.onTaskStatusChanged;
    this.onThreadUpdated = options.onThreadUpdated;
  }

  execute(input: EnqueueExecuteInput): void {
    runExecuteTask(input, {
      apiUrl: this.apiUrl,
      pragmaCliCommand: this.pragmaCliCommand,
      onTaskStatusChanged: this.onTaskStatusChanged,
      onThreadUpdated: this.onThreadUpdated,
    }).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Execute task failed: ${message}`);
    });
  }

  /**
   * Abort an in-progress task execution. Returns true if a task was found and aborted.
   */
  abort(taskId: string): boolean {
    const controller = ACTIVE_TASK_ABORTS.get(taskId);
    if (controller) {
      controller.abort();
      return true;
    }
    return false;
  }
}

async function runExecuteTask(
  input: EnqueueExecuteInput,
  options: {
    apiUrl: string;
    pragmaCliCommand: string;
    onTaskStatusChanged?: (input: TaskStatusChangedInput) => void | Promise<void>;
    onThreadUpdated?: (input: ThreadUpdatedInput) => void | Promise<void>;
  },
): Promise<void> {
  const abortController = new AbortController();
  ACTIVE_TASK_ABORTS.set(input.taskId, abortController);

  const db = await openDatabase(input.workspaceName);
  const paths = getWorkspacePaths(input.workspaceName);

  const taskStateResult = await db.query<{
    git_state_json: string | null;
    predecessor_task_id: string | null;
    followup_task_id: string | null;
  }>(
    `
SELECT git_state_json, predecessor_task_id, followup_task_id
FROM tasks
WHERE id = $1
LIMIT 1
`,
    [input.taskId],
  );
  if (!taskStateResult.rows[0]) {
    throw new Error(`Task not found: ${input.taskId}`);
  }

  const existingGitState = parseTaskGitState(taskStateResult.rows[0].git_state_json);

  // If this is a follow-up task, load predecessor's git state for worktree creation
  let predecessorGitState: TaskGitState | null = null;
  const predecessorTaskId = taskStateResult.rows[0].predecessor_task_id;
  if (predecessorTaskId && !existingGitState) {
    const predResult = await db.query<{ git_state_json: string | null }>(
      `SELECT git_state_json FROM tasks WHERE id = $1 LIMIT 1`,
      [predecessorTaskId],
    );
    if (predResult.rows[0]?.git_state_json) {
      predecessorGitState = parseTaskGitState(predResult.rows[0].git_state_json);
    }
  }

  const prepared = await prepareTaskWorkspace({
    workspacePaths: paths,
    taskId: input.taskId,
    existingState: existingGitState,
    predecessorGitState,
  });
  const outputDir = prepared.outputDir;
  const taskWorkspaceDir = prepared.taskWorkspaceDir;
  const gitState = prepared.gitState;
  const preferredCodePath = resolvePreferredCodePath(gitState);
  const serializedGitState = serializeTaskGitState(gitState);
  await mkdir(outputDir, { recursive: true });

  const turnId = `turn_${randomUUID().slice(0, 12)}`;
  const userMessageId = `msg_${randomUUID().slice(0, 12)}`;
  const isResume = !!input.resumeWorkerSessionId;
  const task = (isResume && input.followUpMessage ? input.followUpMessage : input.prompt).trim();
  const reasoningEffort = input.reasoningEffort;
  const shouldSkipOrchestrator = input.skipOrchestratorSelection === true || isResume || !!input.requestedRecipientAgentId;
  const notifyTaskStatus = async (status: TaskStatus, source: string): Promise<void> => {
    await options.onTaskStatusChanged?.({
      workspaceName: input.workspaceName,
      taskId: input.taskId,
      threadId: input.threadId,
      status,
      source,
    });
  };
  const notifyThreadUpdated = async (source: string): Promise<void> => {
    await options.onThreadUpdated?.({
      workspaceName: input.workspaceName,
      threadId: input.threadId,
      source,
    });
  };
  const insertThreadMessage = async (payload: {
    id: string;
    threadId: string;
    turnId: string | null;
    role: "user" | "assistant" | "system";
    content: string;
  }): Promise<void> => {
    await insertMessage(db, payload);
    await notifyThreadUpdated("message");
  };
  const insertThreadEvent = async (payload: {
    id: string;
    threadId: string;
    turnId: string | null;
    eventName: string;
    payload: unknown;
  }): Promise<void> => {
    await insertEvent(db, payload);
    await notifyThreadUpdated(payload.eventName);
  };

  if (isResume) {
    await reopenThread(db, input.threadId);
    await notifyThreadUpdated("thread_reopened");
  }

  if (shouldSkipOrchestrator) {
    // Check current status to avoid overwriting 'merging' with 'running'
    const currentStatusResult = await db.query<{ status: TaskStatus }>(
      `SELECT status FROM tasks WHERE id = $1 LIMIT 1`,
      [input.taskId],
    );
    const currentTaskStatus = currentStatusResult.rows[0]?.status;
    const preserveMerging = currentTaskStatus === "merging";

    await db.query(
      `
UPDATE tasks
SET status = $6,
    output_dir = $2,
    git_branch_name = $3,
    git_state_json = $4,
    assigned_to = $5,
    test_commands_json = NULL
WHERE id = $1
`,
      [
        input.taskId,
        outputDir,
        gitState.branch_name,
        serializedGitState,
        input.requestedRecipientAgentId ?? null,
        preserveMerging ? "merging" : "running",
      ],
    );
    if (!preserveMerging) {
      await notifyTaskStatus("running", "execute_runner");
    }
  } else {
    await db.query(
      `
UPDATE tasks
SET status = 'orchestrating',
    output_dir = $2,
    git_branch_name = $3,
    git_state_json = $4,
    assigned_to = NULL,
    test_commands_json = NULL
WHERE id = $1
`,
      [input.taskId, outputDir, gitState.branch_name, serializedGitState],
    );
    await notifyTaskStatus("orchestrating", "execute_runner");
  }

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
      orchestratorAgentId: shouldSkipOrchestrator ? null : orchestrator.id,
    });

    await insertThreadMessage({
      id: userMessageId,
      threadId: input.threadId,
      turnId,
      role: "user",
      content: task,
    });

    if (requestedRecipientId && !shouldSkipOrchestrator) {
      await insertThreadEvent({
        id: `evt_${randomUUID().slice(0, 12)}`,
        threadId: input.threadId,
        turnId,
        eventName: "recipient_requested",
        payload: { recipient_agent_id: requestedRecipientId },
      });
    }

    let selectedWorker: AgentRow | null = null;
    let selectionStatus: "auto_selected" | "manual_selected" | "recipient_required" | "invalid" =
      "recipient_required";
    let selectionReason = "";
    if (shouldSkipOrchestrator) {
      if (!requestedWorker) {
        throw new Error("Planned execution requires a selected recipient worker.");
      }
      selectedWorker = requestedWorker;
      selectionStatus = "auto_selected";
      selectionReason = "Recipient manually selected.";
    } else {
      await insertThreadEvent({
        id: `evt_${randomUUID().slice(0, 12)}`,
        threadId: input.threadId,
        turnId,
        eventName: "orchestrator_started",
        payload: {
          task_id: input.taskId,
          orchestrator_agent_id: orchestrator.id,
          harness: orchestrator.harness,
          model_label: orchestrator.model_label,
          model_id: orchestrator.model_id,
          reasoning_effort: reasoningEffort,
        },
      });

      const orchestratorSkills = await listAgentSkills(db, orchestrator.id);

      const orchestratorPrompt = buildOrchestratorPrompt({
        task,
        candidates: workers.map((worker) => ({
          id: worker.id,
          name: worker.name,
          description: worker.description,
          harness: worker.harness,
          modelLabel: worker.model_label,
        })),
        forcedRecipientAgentId: requestedRecipientId,
        reasoningEffort,
        pragmaCliCommand: options.pragmaCliCommand,
        skills: orchestratorSkills,
      });

      const orchestratorAdapter = getConversationAdapter(orchestrator.harness);
      let orchestratorText = "";

      const orchestratorResult = await orchestratorAdapter.sendTurn({
        prompt: orchestratorPrompt,
        modelId: orchestrator.model_id,
        sessionId: null,
        cwd: taskWorkspaceDir,
        env: buildAgentRuntimeEnv({
          apiUrl: options.apiUrl,
          pragmaCliCommand: options.pragmaCliCommand,
          codeDir: join(taskWorkspaceDir, "code"),
          outputDir,
          taskWorkspaceDir,
          workspaceName: input.workspaceName,
          taskId: input.taskId,
          threadId: input.threadId,
          turnId,
          agentId: orchestrator.id,
        }),
        mode: "execute",
        reasoningEffort,
        abortSignal: abortController.signal,
        onEvent: async (event) => {
          if (abortController.signal.aborted) return;

          if (event.type === "assistant_text") {
            orchestratorText = appendText(orchestratorText, event.delta);
            return;
          }

          await insertThreadEvent({
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

      if (requestedWorker) {
        selectedWorker = requestedWorker;
        selectionStatus = "manual_selected";
        selectionReason = "Manual recipient override.";
      } else {
        const selectedRecipientId = await getTaskAssignedRecipientId(db, input.taskId);
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
          selectionStatus: unresolvedStatus,
        });

        await insertThreadMessage({
          id: `msg_${randomUUID().slice(0, 12)}`,
          threadId: input.threadId,
          turnId,
          role: "assistant",
          content: finalOrchestratorText || "Recipient selection requires input.",
        });

        await insertThreadEvent({
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
UPDATE tasks
SET status = 'waiting_for_recipient',
    assigned_to = NULL,
    session_id = $2
WHERE id = $1
`,
          [input.taskId, orchestratorResult.sessionId],
        );
        await notifyTaskStatus("waiting_for_recipient", "execute_runner");
        return;
      }
    }

    if (!selectedWorker) {
      throw new Error("Selected worker was not resolved.");
    }

    // Persist selected worker on the turn before worker streaming starts so UI attribution
    // resolves to the worker instead of falling back to orchestrator.
    await db.query(
      `
UPDATE conversation_turns
SET selected_agent_id = $2,
    selection_status = $3
WHERE id = $1
`,
      [turnId, selectedWorker.id, selectionStatus],
    );

    await insertThreadEvent({
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

    if (!shouldSkipOrchestrator) {
      // Check current status to avoid overwriting 'merging' with 'running'
      const orchStatusResult = await db.query<{ status: TaskStatus }>(
        `SELECT status FROM tasks WHERE id = $1 LIMIT 1`,
        [input.taskId],
      );
      const orchCurrentStatus = orchStatusResult.rows[0]?.status;
      const orchPreserveMerging = orchCurrentStatus === "merging";

      await db.query(
        `
UPDATE tasks
SET assigned_to = $2,
    status = $3
WHERE id = $1
`,
        [input.taskId, selectedWorker.id, orchPreserveMerging ? "merging" : "running"],
      );
      if (!orchPreserveMerging) {
        await notifyTaskStatus("running", "execute_runner");
      }
    }

    await insertThreadEvent({
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
    const workerSkills = await listAgentSkills(db, selectedWorker.id);
    const workerConnectors = await listAgentConnectors(db, selectedWorker.id);

    // Merge connectors into skills for prompt building
    const allSkills = [
      ...workerSkills,
      ...workerConnectors.map((c) => ({
        name: c.name,
        description: c.description ? `[Connector] ${c.description}` : "[Connector]",
      })),
    ];

    const contextDir = join(taskWorkspaceDir, "context");
    const contextEntries = await readdir(contextDir, { withFileTypes: true }).catch(() => []);
    const contextLines: string[] = [];
    for (const entry of contextEntries) {
      if (entry.isFile() && entry.name.endsWith(".md")) {
        contextLines.push(`- context/${entry.name}`);
      } else if (entry.isDirectory()) {
        const nested = await readdir(join(contextDir, entry.name), { withFileTypes: true }).catch(() => []);
        for (const n of nested) {
          if (n.isFile() && n.name.endsWith(".md")) {
            contextLines.push(`- context/${entry.name}/${n.name}`);
          }
        }
      }
    }
    const contextIndex = contextLines.length > 0 ? contextLines.join("\n") : "";

    // Check if the resume session file actually exists on disk.
    // The adapter silently drops --resume when the file is missing, so the worker
    // would get zero prior context. In that case, inject conversation history.
    let conversationHistoryBlock = "";
    if (input.resumeWorkerSessionId) {
      const cwdSlug = resolve(taskWorkspaceDir).replace(/\//g, "-");
      const sessionFile = join(
        homedir(),
        ".claude",
        "projects",
        cwdSlug,
        `${input.resumeWorkerSessionId}.jsonl`,
      );
      if (!existsSync(sessionFile)) {
        const priorMessages = await getThreadMessages(db, input.threadId, 40);
        if (priorMessages.length > 0) {
          conversationHistoryBlock = buildConversationHistoryBlock(priorMessages) || "";
        }
      }
    }

    let workerPrompt = buildWorkerPrompt({
      task,
      workerName: selectedWorker.name,
      workerAgentFile: selectedWorker.agent_file ?? "",
      reasoningEffort,
      pragmaCliCommand: options.pragmaCliCommand,
      preferredCodePath,
      taskWorkspaceDir,
      skills: allSkills,
      contextIndex,
    });

    if (conversationHistoryBlock) {
      workerPrompt = conversationHistoryBlock + "\n\n" + workerPrompt;
    }

    // Build connector env vars (token injection + PATH extension)
    const connectorEnv: Record<string, string> = {};
    for (const c of workerConnectors) {
      connectorEnv[c.env_var] = c.access_token;
    }
    if (workerConnectors.length > 0) {
      connectorEnv.PATH = `${getConnectorBinDir(input.workspaceName)}:${process.env.PATH ?? ""}`;
    }

    let workerText = "";
    const workerResult = await workerAdapter.sendTurn({
      prompt: workerPrompt,
      modelId: selectedWorker.model_id,
      sessionId: input.resumeWorkerSessionId ?? null,
      cwd: taskWorkspaceDir,
      env: {
        ...buildAgentRuntimeEnv({
          apiUrl: options.apiUrl,
          pragmaCliCommand: options.pragmaCliCommand,
          codeDir: join(taskWorkspaceDir, "code"),
          outputDir,
          taskWorkspaceDir,
          workspaceName: input.workspaceName,
          taskId: input.taskId,
          threadId: input.threadId,
          turnId,
          agentId: selectedWorker.id,
        }),
        ...connectorEnv,
      },
      mode: "execute",
      reasoningEffort,
      abortSignal: abortController.signal,
      onEvent: async (event) => {
        if (abortController.signal.aborted) return;

        if (event.type === "assistant_text") {
          workerText = appendText(workerText, event.delta);
          await insertThreadEvent({
            id: `evt_${randomUUID().slice(0, 12)}`,
            threadId: input.threadId,
            turnId,
            eventName: "worker_text",
            payload: {
              delta: event.delta,
              worker_agent_id: selectedWorker.id,
            },
          });
          return;
        }

        await insertThreadEvent({
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
      selectedAgentId: selectedWorker.id,
      workerSessionId: workerResult.sessionId,
      selectionStatus,
    });

    await insertThreadMessage({
      id: assistantMessageId,
      threadId: input.threadId,
      turnId,
      role: "assistant",
      content: finalWorkerText,
    });

    await insertThreadEvent({
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

    await checkpointTaskRepos({
      workspacePaths: paths,
      taskId: input.taskId,
      gitState,
      commitMessage: `pragma: task ${input.taskId} checkpoint`,
    });

    await closeThread(db, input.threadId);

    const statusResult = await db.query<{ status: TaskStatus }>(
      `
SELECT status
FROM tasks
WHERE id = $1
LIMIT 1
`,
      [input.taskId],
    );

    const currentStatus = statusResult.rows[0]?.status ?? null;
    if (currentStatus === "merging") {
      // Auto-merge: the user already approved, agent just resolved conflicts
      await autoMergeAfterConflictResolution(db, input, paths, gitState, workerResult.sessionId, notifyTaskStatus, options);
    } else if (!isWaitingForHumanResponseStatus(currentStatus)) {
      await db.query(
        `
UPDATE tasks
SET status = 'pending_review',
    session_id = $2
WHERE id = $1
`,
        [input.taskId, workerResult.sessionId],
      );
      await notifyTaskStatus("pending_review", "execute_runner");

      // Trigger follow-up task execution if one exists
      // Re-query followup_task_id from DB since it may have been set while this task was running
      const followupCheck = await db.query<{ followup_task_id: string | null }>(
        `SELECT followup_task_id FROM tasks WHERE id = $1 LIMIT 1`,
        [input.taskId],
      );
      const followupTaskId = followupCheck.rows[0]?.followup_task_id;
      if (followupTaskId) {
        const followupResult = await db.query<{
          id: string;
          status: string;
          plan: string | null;
        }>(
          `SELECT id, status, plan FROM tasks WHERE id = $1 LIMIT 1`,
          [followupTaskId],
        );
        const followup = followupResult.rows[0];
        if (followup && followup.status === "queued") {
          const followupThread = await getThreadByTaskId(db, followupTaskId);
          if (followupThread) {
            const followupTurn = await getFirstExecuteTurn(db, followupThread.id);
            const followupPrompt = followup.plan || followupTurn?.user_message || "";
            if (followupPrompt.trim()) {
              // Fire-and-forget: start the follow-up task
              runExecuteTask(
                {
                  workspaceName: input.workspaceName,
                  taskId: followupTaskId,
                  threadId: followupThread.id,
                  prompt: followupPrompt,
                  reasoningEffort: input.reasoningEffort,
                },
                options,
              ).catch(async (err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`Follow-up task execution failed: ${msg}`);
                try {
                  const errDb = await openDatabase(input.workspaceName);
                  await errDb.query(
                    `UPDATE tasks SET status = 'failed', completed_at = CURRENT_TIMESTAMP WHERE id = $1`,
                    [followupTaskId],
                  );
                  await options.onTaskStatusChanged?.({
                    workspaceName: input.workspaceName,
                    taskId: followupTaskId,
                    threadId: followupThread.id,
                    status: "failed",
                    source: "followup_start_failed",
                  });
                } catch { /* best-effort */ }
              });
            }
          }
        }
      }
    }
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);

    await failTurn(db, turnId, message);

    await insertThreadEvent({
      id: `evt_${randomUUID().slice(0, 12)}`,
      threadId: input.threadId,
      turnId,
      eventName: "error",
      payload: { message },
    });

    await closeThread(db, input.threadId);

    await db.query(
      `
UPDATE tasks
SET status = 'failed',
    completed_at = CURRENT_TIMESTAMP
WHERE id = $1
`,
      [input.taskId],
    );
    await notifyTaskStatus("failed", "execute_runner");
  } finally {
    ACTIVE_TASK_ABORTS.delete(input.taskId);
    await db.close();
  }
}

async function getAgentById(
  db: Awaited<ReturnType<typeof openDatabase>>,
  id: string,
): Promise<AgentRow | null> {
  const result = await db.query<AgentRow>(
    `
SELECT id, name, description, agent_file, harness, model_label, model_id
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
SELECT id, name, description, agent_file, harness, model_label, model_id
FROM agents
WHERE id <> $1
ORDER BY name ASC
`,
    [orchestratorId],
  );

  return result.rows;
}

async function getTaskAssignedRecipientId(
  db: Awaited<ReturnType<typeof openDatabase>>,
  taskId: string,
): Promise<string | null> {
  const result = await db.query<{ assigned_to: string | null }>(
    `
SELECT assigned_to
FROM tasks
WHERE id = $1
LIMIT 1
`,
    [taskId],
  );

  return result.rows[0]?.assigned_to ?? null;
}

function buildAgentRuntimeEnv(input: {
  apiUrl: string;
  pragmaCliCommand: string;
  codeDir: string;
  outputDir: string;
  taskWorkspaceDir: string;
  workspaceName: string;
  taskId: string;
  threadId: string;
  turnId: string;
  agentId: string;
}): Record<string, string> {
  return {
    PRAGMA_API_URL: input.apiUrl,
    PRAGMA_CLI_COMMAND: input.pragmaCliCommand,
    PRAGMA_CODE_DIR: input.codeDir,
    PRAGMA_OUTPUT_DIR: input.outputDir,
    PRAGMA_TASK_WORKSPACE: input.taskWorkspaceDir,
    PRAGMA_WORKSPACE_NAME: input.workspaceName,
    PRAGMA_TASK_ID: input.taskId,
    PRAGMA_THREAD_ID: input.threadId,
    PRAGMA_TURN_ID: input.turnId,
    PRAGMA_AGENT_ID: input.agentId,
  };
}

async function listAgentSkills(
  db: Awaited<ReturnType<typeof openDatabase>>,
  agentId: string,
): Promise<Array<{ name: string; description: string | null }>> {
  const result = await db.query<{ name: string; description: string | null }>(
    `SELECT s.name, s.description
     FROM skills s
     JOIN agent_skills as_rel ON as_rel.skill_id = s.id
     WHERE as_rel.agent_id = $1
     ORDER BY s.name ASC`,
    [agentId],
  );

  return result.rows;
}

async function listAgentConnectors(
  db: Awaited<ReturnType<typeof openDatabase>>,
  agentId: string,
): Promise<Array<{
  name: string;
  description: string | null;
  env_var: string;
  access_token: string;
  binary_name: string;
}>> {
  const result = await db.query<{
    id: string;
    name: string;
    description: string | null;
    env_var: string;
    access_token: string | null;
    refresh_token: string | null;
    token_expires_at: string | null;
    oauth_token_url: string;
    oauth_client_id: string | null;
    oauth_client_secret: string | null;
    binary_name: string;
    auth_type: string;
  }>(
    `SELECT c.id, c.name, c.description, c.env_var, c.access_token,
            c.refresh_token, c.token_expires_at, c.oauth_token_url,
            c.oauth_client_id, c.oauth_client_secret, c.binary_name, c.auth_type
     FROM connectors c
     JOIN agent_connectors ac ON ac.connector_id = c.id
     WHERE ac.agent_id = $1 AND c.status = 'connected'
     ORDER BY c.name ASC`,
    [agentId],
  );

  const rows: Array<{
    name: string;
    description: string | null;
    env_var: string;
    access_token: string;
    binary_name: string;
  }> = [];

  for (const row of result.rows) {
    let token: string;
    try {
      token = await refreshConnectorTokenForRunner(db, row);
    } catch {
      continue; // Skip connectors that fail to refresh
    }
    rows.push({
      name: row.name,
      description: row.description,
      env_var: row.env_var,
      access_token: token,
      binary_name: row.binary_name,
    });
  }

  return rows;
}

async function refreshConnectorTokenForRunner(
  db: Awaited<ReturnType<typeof openDatabase>>,
  connector: {
    id: string;
    name: string;
    access_token: string | null;
    refresh_token: string | null;
    token_expires_at: string | null;
    oauth_token_url: string;
    oauth_client_id: string | null;
    oauth_client_secret: string | null;
    auth_type: string;
  },
): Promise<string> {
  if (connector.auth_type === "api_key") {
    return connector.access_token!;
  }

  if (
    connector.token_expires_at &&
    new Date(connector.token_expires_at) > new Date()
  ) {
    return connector.access_token!;
  }

  if (!connector.refresh_token) {
    throw new Error("No refresh token available");
  }

  // Check if this connector uses the OAuth proxy
  const registryDef = CONNECTOR_REGISTRY.find((d) => d.name === connector.name);
  let response: Response;

  if (registryDef?.proxyProvider) {
    response = await fetch(`${OAUTH_PROXY_URL}/refresh/${registryDef.proxyProvider}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: connector.refresh_token }),
    });
  } else {
    response = await fetch(connector.oauth_token_url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: connector.refresh_token,
        client_id: connector.oauth_client_id!,
        client_secret: connector.oauth_client_secret!,
      }),
    });
  }

  if (!response.ok) {
    await db.query(
      `UPDATE connectors SET status = 'disconnected', access_token = NULL,
       refresh_token = NULL, token_expires_at = NULL WHERE id = $1`,
      [connector.id],
    );
    throw new Error("Token refresh failed");
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  await db.query(
    `UPDATE connectors SET access_token = $1, refresh_token = COALESCE($2, refresh_token),
     token_expires_at = $3 WHERE id = $4`,
    [
      data.access_token,
      data.refresh_token ?? null,
      new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
      connector.id,
    ],
  );

  return data.access_token;
}

function resolvePreferredCodePath(gitState: TaskGitState): string | null {
  const codeRepos = gitState.repos
    .map((repo) => repo.relative_path)
    .filter((path) => path.startsWith("code/"));
  if (codeRepos.length === 0) {
    return null;
  }

  const nonDefaultRepos = codeRepos.filter((path) => path !== "code/default");
  if (nonDefaultRepos.length === 0 && codeRepos.includes("code/default")) {
    return "code/default";
  }

  return null;
}

async function autoMergeAfterConflictResolution(
  db: Awaited<ReturnType<typeof openDatabase>>,
  input: EnqueueExecuteInput,
  paths: ReturnType<typeof getWorkspacePaths>,
  gitState: TaskGitState,
  sessionId: string,
  notifyTaskStatus: (status: TaskStatus, source: string) => Promise<void>,
  options: {
    apiUrl: string;
    pragmaCliCommand: string;
    onTaskStatusChanged?: (input: TaskStatusChangedInput) => void | Promise<void>;
    onThreadUpdated?: (input: ThreadUpdatedInput) => void | Promise<void>;
  },
): Promise<void> {
  const taskResult = await db.query<{
    push_after_merge: boolean;
    predecessor_task_id: string | null;
    title: string;
  }>(
    `SELECT push_after_merge, predecessor_task_id, title FROM tasks WHERE id = $1 LIMIT 1`,
    [input.taskId],
  );
  const task = taskResult.rows[0];
  if (!task) {
    return;
  }

  const mergeResult = await mergeApprovedTask({
    workspacePaths: paths,
    taskId: input.taskId,
    taskTitle: task.title,
    gitState,
  });

  if (mergeResult.conflicts.length === 0) {
    // Merge succeeded — collect chain tasks if any
    const chainTaskIds: string[] = [input.taskId];
    let currentPredecessorId = task.predecessor_task_id;
    while (currentPredecessorId) {
      chainTaskIds.push(currentPredecessorId);
      const predResult = await db.query<{ predecessor_task_id: string | null }>(
        `SELECT predecessor_task_id FROM tasks WHERE id = $1 LIMIT 1`,
        [currentPredecessorId],
      );
      currentPredecessorId = predResult.rows[0]?.predecessor_task_id ?? null;
    }

    for (const chainId of chainTaskIds) {
      const mergedOutputDir = getTaskMainOutputDir(paths, chainId);
      await db.query(
        `UPDATE tasks SET status = 'completed', output_dir = $2, session_id = $3, completed_at = CURRENT_TIMESTAMP, push_after_merge = FALSE WHERE id = $1`,
        [chainId, mergedOutputDir, chainId === input.taskId ? sessionId : undefined],
      );
      await options.onTaskStatusChanged?.({
        workspaceName: input.workspaceName,
        taskId: chainId,
        threadId: input.threadId,
        status: "completed",
        source: "auto_merge",
      });
    }

    await saveDiffSnapshot({ db, workspacePaths: paths, taskId: input.taskId, gitState });

    for (const chainId of chainTaskIds) {
      ACTIVE_TASK_ABORTS.delete(chainId);
      await deleteTaskWorktree({ workspacePaths: paths, taskId: chainId });
    }

    if (task.push_after_merge) {
      for (const repo of gitState.repos) {
        const repoPath = repo.relative_path === "."
          ? paths.workspaceDir
          : join(paths.workspaceDir, repo.relative_path);
        await runCommand({
          command: "git",
          args: ["push", "origin", repo.base_branch],
          cwd: repoPath,
          env: process.env,
        });
      }
    }
  } else {
    // Still conflicts after agent tried — fall back to needs_fix
    await db.query(
      `UPDATE tasks SET status = 'needs_fix', push_after_merge = FALSE WHERE id = $1`,
      [input.taskId],
    );
    await notifyTaskStatus("needs_fix", "auto_merge_conflict");
  }
}

function isWaitingForHumanResponseStatus(status: TaskStatus | null): boolean {
  return status === "waiting_for_question_response" || status === "waiting_for_help_response";
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
