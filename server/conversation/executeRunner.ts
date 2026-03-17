import { randomUUID } from "node:crypto";
import { appendFile, mkdir, readdir } from "node:fs/promises";
import { join } from "node:path";
import { DEFAULT_AGENT_ID, getWorkspacePaths, openDatabase } from "../db";
import { getConversationAdapter } from "./adapters";
import {
  checkpointTaskRepos,
  parseTaskGitState,
  prepareTaskWorkspace,
  serializeTaskGitState,
} from "./gitWorkflow";
import type { TaskGitState } from "./gitWorkflow";
import { buildOrchestratorPrompt, buildWorkerPrompt } from "./prompts";
import {
  closeThread,
  completeTurn,
  createTurn,
  failTurn,
  getFirstExecuteTurn,
  getThreadByTaskId,
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
  const logFile = join(outputDir, "events.jsonl");
  await mkdir(outputDir, { recursive: true });

  const turnId = `turn_${randomUUID().slice(0, 12)}`;
  const userMessageId = `msg_${randomUUID().slice(0, 12)}`;
  const isResume = !!input.resumeWorkerSessionId;
  const task = (isResume && input.followUpMessage ? input.followUpMessage : input.prompt).trim();
  const reasoningEffort = input.reasoningEffort;
  const shouldSkipOrchestrator = input.skipOrchestratorSelection === true || isResume;
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
    await db.query(
      `
UPDATE tasks
SET status = 'running',
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
      ],
    );
    await notifyTaskStatus("running", "execute_runner");
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
      selectionReason = "Recipient selected during plan mode.";
      await appendJsonLine(logFile, {
        type: "recipient_selected_from_plan",
        selected_agent_id: selectedWorker.id,
      });
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

      await appendJsonLine(logFile, {
        type: "orchestrator_started",
        task_id: input.taskId,
        thread_id: input.threadId,
        turn_id: turnId,
        orchestrator_agent_id: orchestrator.id,
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
        onEvent: async (event) => {
          await appendJsonLine(logFile, {
            phase: "orchestrator",
            ...event,
          });

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

        await appendJsonLine(logFile, {
          type: "recipient_required",
          reason,
        });
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
      await db.query(
        `
UPDATE tasks
SET assigned_to = $2,
    status = 'running'
WHERE id = $1
`,
        [input.taskId, selectedWorker.id],
      );
      await notifyTaskStatus("running", "execute_runner");
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

    const workerPrompt = buildWorkerPrompt({
      task,
      workerName: selectedWorker.name,
      workerAgentFile: selectedWorker.agent_file ?? "",
      reasoningEffort,
      pragmaCliCommand: options.pragmaCliCommand,
      preferredCodePath,
      taskWorkspaceDir,
      skills: workerSkills,
      contextIndex,
    });

    let workerText = "";
    const workerResult = await workerAdapter.sendTurn({
      prompt: workerPrompt,
      modelId: selectedWorker.model_id,
      sessionId: input.resumeWorkerSessionId ?? null,
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
    if (!isWaitingForHumanResponseStatus(currentStatus)) {
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
              ).catch((err: unknown) => {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(`Follow-up task execution failed: ${msg}`);
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

function isWaitingForHumanResponseStatus(status: TaskStatus | null): boolean {
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
