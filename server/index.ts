import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import { homedir } from "node:os";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
import type { Context } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";
import { lookup as lookupMimeType } from "mime-types";
import open from "open";
import { z } from "zod";
import {
  DEFAULT_AGENT_ID,
  PragmaError,
  createWorkspace,
  deleteWorkspace,
  closeOpenDatabases,
  getActiveWorkspaceName,
  getWorkspacePaths,
  listWorkspaceNames,
  openDatabase,
  setActiveWorkspaceName,
  setupPragma,
  updateTaskTitle,
} from "./db";
import { generateTitle } from "./conversation/titleGenerator";
import { ExecuteRunner } from "./conversation/executeRunner";
import { TurnRunner } from "./conversation/turnRunner";
import {
  buildRepoDiffEntries,
  deleteTaskWorktree,
  getMainChangesSummary,
  getTaskMainOutputDir,
  mergeApprovedTask,
  parseTaskGitState,
  resolveRepoPath,
  saveDiffSnapshot,
  syncTaskOutputsBackToWorkspace,
} from "./conversation/gitWorkflow";
import type { TaskGitState, WorkspacePathsLike, MergeConflict } from "./conversation/gitWorkflow";
import type { PGlite } from "@electric-sql/pglite";
import { resolveModelId } from "./conversation/models";
import { isLoopbackOrigin } from "../shared/net";
import { allAdapterDefinitions, getAdapterDefinition } from "./conversation/adapterRegistry";
import { resolvePragmaCliCommand } from "./conversation/pragmaCli";
import {
  closeThread,
  createThread,
  createTurn,
  ensureConversationSchema,
  getLatestCompletedPlanTurn,
  getLatestPlanTurn,
  getFirstExecuteTurn,
  getLatestExecuteTurn,
  getThreadByTaskId,
  getThreadById,
  getThreadWithDetails,
  getEventsSince,
  getMaxEventSeq,
  getPlanProposal,
  insertEvent,
  insertMessage,
  listChatThreads,
  listOpenPlanThreads,
  reopenThread,
  setThreadTaskId,
  storePlanProposal,
  updateChatThreadMetadata,
  updateThreadSession,
  completeTurn,
  failTurn,
} from "./conversation/store";
import type { HarnessId, TaskStatus, ReasoningEffort } from "./conversation/types";
import {
  agentSubmitTestCommandsSchema,
  agentSubmitTestingConfigSchema,
  agentAskQuestionSchema,
  agentRequestHelpSchema,
  agentSelectRecipientSchema,
  chatsQuerySchema,
  createCodeFolderCopySchema,
  createCodeRepoCloneSchema,
  conversationTurnSchema,
  createAgentSchema,
  createContextFileSchema,
  createHumanSchema,
  createContextFolderSchema,
  createExecuteTaskSchema,
  createFollowupTaskSchema,
  createTaskSchema,
  createWorkspaceSchema,
  executeFromThreadSchema,
  tasksQuerySchema,
  taskRespondSchema,
  stopTaskSchema,
  openOutputFolderSchema,
  outputFileQuerySchema,
  planProposeSchema,
  plansQuerySchema,
  planSelectRecipientSchema,
  executePlanProposalSchema,
  reviewTaskSchema,
  runTaskTestCommandSchema,
  updateTaskTestCommandsSchema,
  testingProxyRequestSchema,
  serviceStdinSchema,
  setActiveWorkspaceSchema,
  setTaskRecipientSchema,
  updateAgentSchema,
  updateContextFileSchema,
  updateHumanSchema,
  createSkillSchema,
  updateSkillSchema,
  assignAgentSkillSchema,
  configureConnectorSchema,
  createCustomConnectorSchema,
  updateCustomConnectorSchema,
  assignAgentConnectorSchema,
  dbQuerySchema,
  createProcessSchema,
  updateProcessSchema,
} from "./http/schemas";
import { validateJson, validateQuery } from "./http/validators";
import { workspaceMiddleware, type WorkspaceEnv } from "./http/middleware";
import { runCommand, runShellCommandDetailed, spawnShellCommand } from "./process/runCommand";
import { CONNECTOR_REGISTRY, OAUTH_PROXY_URL } from "./connectorRegistry";
import { ensureConnectorBinary } from "./connectorBinaries";
import {
  listAgents,
  getAgentById,
  insertAgent,
  updateAgent as updateAgentStore,
  deleteAgent as deleteAgentStore,
  generateNextAgentId,
  listPlanWorkerCandidates,
} from "./stores/agentStore";
import {
  listHumans,
  insertHuman,
  updateHuman as updateHumanStore,
  deleteHuman as deleteHumanStore,
} from "./stores/humanStore";
import {
  listSkills as listSkillsStore,
  insertSkill,
  updateSkill as updateSkillStore,
  deleteSkill as deleteSkillStore,
  getAgentSkills as getAgentSkillsStore,
  assignAgentSkill,
  unassignAgentSkill,
  getAgentSkillContent,
  skillExists,
} from "./stores/skillStore";
import {
  listConnectors as listConnectorsStore,
  getConnectorAuthInfo,
  getConnectorForConfig,
  setConnectorApiKeyToken,
  updateConnectorOAuthConfig,
  connectorExists,
  storeConnectorTokens,
  disconnectConnector,
  refreshConnectorToken as refreshConnectorTokenStore,
  getConnectorName,
  getAgentConnectors as getAgentConnectorsStore,
  assignAgentConnector,
  unassignAgentConnector,
  getAgentConnectorContent,
  getConnectorTokenInfo,
  agentExists,
} from "./stores/connectorStore";
import {
  listTasks,
  getTaskDetail,
  getTaskStatus,
  getTaskStatusAndAssignment,
  getTaskWithTestCommands,
  getTaskChangesInfo,
  getTaskPlan,
  getTaskTestCommands as getTaskTestCommandsStore,
  getTaskOutputDir,
  insertTask,
  updateTaskStatus,
  updateTaskTestCommandsJson,
  updateTaskAssignment,
  setTaskFollowup,
  getTaskFollowupInfo,
  getTaskCurrentStatus,
  getTaskPredecessorId,
  updateTaskForPlanExecution,
  getStoredPlanRecipientForTurn,
  updateTurnRecipient,
  getTurnForPlanValidation,
} from "./stores/taskStore";

/** Walk predecessor chain from a task, returning all task IDs in chain order (current first). */
async function walkPredecessorChain(
  db: PGlite,
  taskId: string,
  predecessorTaskId: string | null,
): Promise<string[]> {
  const chainTaskIds: string[] = [taskId];
  let currentPredecessorId = predecessorTaskId;
  while (currentPredecessorId) {
    chainTaskIds.push(currentPredecessorId);
    const predResult = await db.query<{ predecessor_task_id: string | null }>(
      `SELECT predecessor_task_id FROM tasks WHERE id = $1 LIMIT 1`,
      [currentPredecessorId],
    );
    currentPredecessorId = predResult.rows[0]?.predecessor_task_id ?? null;
  }
  return chainTaskIds;
}

/** Mark all tasks in a chain as completed: sync outputs, update DB, emit status, abort runners, delete worktrees. */
async function completeChainTasks(
  db: PGlite,
  workspacePaths: ReturnType<typeof getWorkspacePaths>,
  chainTaskIds: string[],
  emitTaskStatus: (workspaceName: string, taskId: string, status: TaskStatus, source: string) => void,
  executeRunner: { abort(taskId: string): void },
  workspaceName: string,
  source: string,
): Promise<void> {
  for (const chainId of chainTaskIds) {
    await syncTaskOutputsBackToWorkspace({ workspacePaths, taskId: chainId });
    const mergedOutputDir = getTaskMainOutputDir(workspacePaths, chainId);
    await mkdir(mergedOutputDir, { recursive: true });
    await db.query(
      `UPDATE tasks SET status = 'completed', output_dir = $2, completed_at = CURRENT_TIMESTAMP WHERE id = $1 AND status <> 'completed'`,
      [chainId, mergedOutputDir],
    );
    emitTaskStatus(workspaceName, chainId, "completed", source);
    executeRunner.abort(chainId);
    await deleteTaskWorktree({ workspacePaths, taskId: chainId });
  }
}

/** Push all repos in a git state to their origin base branches. */
async function pushReposToOrigin(
  gitState: TaskGitState,
  workspacePaths: WorkspacePathsLike,
): Promise<void> {
  for (const repo of gitState.repos) {
    const repoPath = repo.relative_path === "."
      ? workspacePaths.workspaceDir
      : join(workspacePaths.workspaceDir, repo.relative_path);
    await runCommand({
      command: "git",
      args: ["push", "origin", repo.base_branch],
      cwd: repoPath,
      env: process.env,
    });
  }
}

/**
 * Attempt to enrich merge conflicts and enqueue a retry execution.
 * Returns "retried" if the retry was enqueued, "retry_exhausted" if retries are used up,
 * or "missing_context" if the retry was started but thread/turn context was unavailable.
 */
async function handleMergeConflictRetry(input: {
  db: PGlite;
  workspacePaths: ReturnType<typeof getWorkspacePaths>;
  taskId: string;
  gitState: TaskGitState;
  task: { assigned_to: string | null; merge_retry_count: number | null };
  mergeConflicts: MergeConflict[];
  pushAfterMerge: boolean;
  workspaceName: string;
  emitTaskStatus: (workspaceName: string, taskId: string, status: TaskStatus, source: string) => void;
  executeRunner: {
    execute(opts: {
      workspaceName: string;
      taskId: string;
      threadId: string;
      prompt: string;
      requestedRecipientAgentId?: string;
      reasoningEffort: ReasoningEffort;
    }): void;
  };
  statusSource: string;
}): Promise<
  | { outcome: "retried"; response: object }
  | { outcome: "retry_exhausted" }
  | { outcome: "missing_context" }
> {
  const { db, workspacePaths, taskId, gitState, task, mergeConflicts, pushAfterMerge, workspaceName, emitTaskStatus, executeRunner, statusSource } = input;
  const retryCount = Number.isInteger(task.merge_retry_count) ? (task.merge_retry_count as number) : 0;
  if (retryCount >= 1) {
    return { outcome: "retry_exhausted" };
  }

  await db.query(
    `UPDATE tasks SET status = 'merging', merge_retry_count = COALESCE(merge_retry_count, 0) + 1, push_after_merge = $2 WHERE id = $1`,
    [taskId, pushAfterMerge],
  );
  emitTaskStatus(workspaceName, taskId, "merging", statusSource);

  const thread = await getThreadByTaskId(db, taskId);
  const latestExecuteTurn = thread ? await getLatestExecuteTurn(db, thread.id) : null;
  if (!thread || !latestExecuteTurn || !latestExecuteTurn.user_message.trim()) {
    return { outcome: "missing_context" };
  }

  const taskWorkspaceDir = join(workspacePaths.worktreesDir, taskId, "workspace");
  const enrichedConflicts = await Promise.all(
    mergeConflicts.map(async (conflict) => {
      const repo = gitState.repos.find((r) => r.relative_path === conflict.repo_path);
      const sourceRepoPath = resolveRepoPath(workspacePaths.workspaceDir, conflict.repo_path);
      const taskRepoPath = resolveRepoPath(taskWorkspaceDir, conflict.repo_path);
      const mainChangesSummary = repo
        ? await getMainChangesSummary({
            sourceRepoPath,
            baseCommit: repo.base_commit,
            baseBranch: repo.base_branch,
            files: conflict.files,
          })
        : "";
      return {
        repo_path: conflict.repo_path,
        files: conflict.files,
        taskRepoPath,
        branchName: gitState.branch_name,
        baseBranch: repo?.base_branch ?? "main",
        mainChangesSummary,
      };
    }),
  );
  const retryPrompt = buildConflictRetryPrompt({
    originalTask: latestExecuteTurn.user_message,
    conflicts: enrichedConflicts,
  });
  executeRunner.execute({
    workspaceName,
    taskId,
    threadId: thread.id,
    prompt: retryPrompt,
    requestedRecipientAgentId: task.assigned_to ?? undefined,
    reasoningEffort: requireReasoningEffort(
      latestExecuteTurn.reasoning_effort,
      `latest execute turn for conflict retry task ${taskId}`,
    ),
  });

  return {
    outcome: "retried",
    response: {
      ok: true,
      status: "merging",
      merge_state: "conflict_retry_enqueued",
      conflicts: mergeConflicts,
    },
  };
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}


type StartServerOptions = {
  port: number;
};

type TaskStatusStreamEvent = {
  task_id: string;
  thread_id?: string;
  status: TaskStatus;
  changed_at: string;
  source: string;
};

type TaskStatusListener = (event: TaskStatusStreamEvent) => void;
type ThreadUpdateListener = (event: {
  thread_id: string;
  changed_at: string;
  source: string;
}) => void;

type RuntimeServiceStatus = "running" | "ready" | "exited" | "stopped";
type RuntimeServiceLogStream = "stdout" | "stderr" | "system";

type RuntimeServiceLogEntry = {
  seq: number;
  ts: string;
  stream: RuntimeServiceLogStream;
  text: string;
};

type RuntimeServiceSummary = {
  id: string;
  workspace: string;
  task_id: string;
  label: string;
  command: string;
  cwd: string;
  status: RuntimeServiceStatus;
  pid: number | null;
  port: number | null;
  exit_code: number | null;
  started_at: string;
  ended_at: string | null;
};

type RuntimeServiceStreamEvent =
  | { type: "log"; entry: RuntimeServiceLogEntry }
  | { type: "status"; service: RuntimeServiceSummary };

type RuntimeServiceListener = (event: RuntimeServiceStreamEvent) => void;

type RuntimeServiceRecord = RuntimeServiceSummary & {
  absolute_cwd: string;
  stop_requested: boolean;
  next_seq: number;
  logs: RuntimeServiceLogEntry[];
  listeners: Set<RuntimeServiceListener>;
  _child: import("execa").ExecaChildProcess<string> | null;
  process_db_id?: string;
};

const TASK_STATUS_LISTENERS = new Map<string, Set<TaskStatusListener>>();
const THREAD_UPDATE_LISTENERS = new Map<string, Set<ThreadUpdateListener>>();
const RUNTIME_SERVICES_BY_WORKSPACE = new Map<string, Map<string, RuntimeServiceRecord>>();

function threadListenerKey(workspaceName: string, threadId: string): string {
  return `${workspaceName}:${threadId}`;
}

function subscribeTaskStatus(workspaceName: string, listener: TaskStatusListener): () => void {
  const current = TASK_STATUS_LISTENERS.get(workspaceName);
  if (current) {
    current.add(listener);
  } else {
    TASK_STATUS_LISTENERS.set(workspaceName, new Set([listener]));
  }

  return () => {
    const listeners = TASK_STATUS_LISTENERS.get(workspaceName);
    if (!listeners) {
      return;
    }
    listeners.delete(listener);
    if (listeners.size === 0) {
      TASK_STATUS_LISTENERS.delete(workspaceName);
    }
  };
}

function publishTaskStatus(workspaceName: string, event: TaskStatusStreamEvent): void {
  const listeners = TASK_STATUS_LISTENERS.get(workspaceName);
  if (!listeners || listeners.size === 0) {
    return;
  }

  for (const listener of listeners) {
    listener(event);
  }
}

function subscribeThreadUpdates(
  workspaceName: string,
  threadId: string,
  listener: ThreadUpdateListener,
): () => void {
  const key = threadListenerKey(workspaceName, threadId);
  const current = THREAD_UPDATE_LISTENERS.get(key);
  if (current) {
    current.add(listener);
  } else {
    THREAD_UPDATE_LISTENERS.set(key, new Set([listener]));
  }

  return () => {
    const listeners = THREAD_UPDATE_LISTENERS.get(key);
    if (!listeners) {
      return;
    }
    listeners.delete(listener);
    if (listeners.size === 0) {
      THREAD_UPDATE_LISTENERS.delete(key);
    }
  };
}

function publishThreadUpdated(
  workspaceName: string,
  threadId: string,
  source: string,
): void {
  const key = threadListenerKey(workspaceName, threadId);
  const listeners = THREAD_UPDATE_LISTENERS.get(key);
  if (!listeners || listeners.size === 0) {
    return;
  }

  const event = {
    thread_id: threadId,
    changed_at: new Date().toISOString(),
    source,
  };
  for (const listener of listeners) {
    listener(event);
  }
}

type WriteEventFn = (
  eventName: string,
  payload: Record<string, unknown>,
  seq?: number,
) => Promise<void>;

type SSEStreamOptions = {
  setup: (writeEvent: WriteEventFn) => (() => void) | Promise<() => void>;
  closedSignal?: () => boolean;
};

function createSSEStream(
  c: Context,
  options: SSEStreamOptions,
): Response {
  c.header("cache-control", "no-store");
  c.header("connection", "keep-alive");

  return streamSSE(c, async (stream) => {
    let closed = false;
    const writeEvent: WriteEventFn = async (eventName, payload, seq) => {
      if (closed) return;
      try {
        await stream.writeSSE({
          event: eventName,
          data: JSON.stringify(payload),
          ...(seq != null ? { id: String(seq) } : {}),
        });
      } catch {
        closed = true;
      }
    };

    const unsubscribe = await options.setup(writeEvent);

    const pingTimer = setInterval(() => {
      void writeEvent("ping", { ts: new Date().toISOString() });
    }, 15000);

    const abortSignal = c.req.raw.signal;
    await new Promise<void>((resolve) => {
      if (abortSignal.aborted || closed) {
        resolve();
        return;
      }
      let pollInterval: ReturnType<typeof setInterval> | undefined;
      const done = () => {
        if (pollInterval) clearInterval(pollInterval);
        resolve();
      };
      abortSignal.addEventListener("abort", done, { once: true });
      if (options.closedSignal) {
        pollInterval = setInterval(() => {
          if (closed || options.closedSignal!()) done();
        }, 500);
      }
    });

    closed = true;
    clearInterval(pingTimer);
    unsubscribe();
  });
}

async function getRandomFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function getWorkspaceServiceStore(
  workspaceName: string,
  createIfMissing = false,
): Map<string, RuntimeServiceRecord> {
  const existing = RUNTIME_SERVICES_BY_WORKSPACE.get(workspaceName);
  if (existing) {
    return existing;
  }
  if (!createIfMissing) {
    return new Map<string, RuntimeServiceRecord>();
  }
  const created = new Map<string, RuntimeServiceRecord>();
  RUNTIME_SERVICES_BY_WORKSPACE.set(workspaceName, created);
  return created;
}

function toRuntimeServiceSummary(service: RuntimeServiceRecord): RuntimeServiceSummary {
  return {
    id: service.id,
    workspace: service.workspace,
    task_id: service.task_id,
    label: service.label,
    command: service.command,
    cwd: service.cwd,
    status: service.status,
    pid: service.pid,
    port: service.port,
    exit_code: service.exit_code,
    started_at: service.started_at,
    ended_at: service.ended_at,
  };
}

function listRuntimeServices(workspaceName: string): RuntimeServiceSummary[] {
  const store = getWorkspaceServiceStore(workspaceName);
  return [...store.values()]
    .sort((a, b) => {
      if (a.status === "running" && b.status !== "running") return -1;
      if (a.status !== "running" && b.status === "running") return 1;
      return b.started_at.localeCompare(a.started_at);
    })
    .map((service) => toRuntimeServiceSummary(service));
}

function getRuntimeService(workspaceName: string, serviceId: string): RuntimeServiceRecord | null {
  const store = getWorkspaceServiceStore(workspaceName);
  return store.get(serviceId) ?? null;
}

function publishRuntimeServiceEvent(
  service: RuntimeServiceRecord,
  event: RuntimeServiceStreamEvent,
): void {
  for (const listener of service.listeners) {
    listener(event);
  }
}

function appendRuntimeServiceLog(
  service: RuntimeServiceRecord,
  stream: RuntimeServiceLogStream,
  text: string,
): void {
  if (!text) {
    return;
  }

  const entry: RuntimeServiceLogEntry = {
    seq: service.next_seq,
    ts: new Date().toISOString(),
    stream,
    text,
  };
  service.next_seq += 1;
  service.logs.push(entry);
  publishRuntimeServiceEvent(service, { type: "log", entry });
}

function updateRuntimeServiceStatus(
  service: RuntimeServiceRecord,
  status: RuntimeServiceStatus,
  exitCode: number | null,
): void {
  service.status = status;
  service.exit_code = exitCode;
  service.ended_at = new Date().toISOString();
  publishRuntimeServiceEvent(service, {
    type: "status",
    service: toRuntimeServiceSummary(service),
  });

  if (service.process_db_id) {
    void updateProcessDbStatus(service.workspace, service.process_db_id, status, exitCode);
  }
}

async function updateProcessDbStatus(
  workspaceName: string,
  processDbId: string,
  status: RuntimeServiceStatus,
  exitCode: number | null,
): Promise<void> {
  try {
    const db = await openDatabase(workspaceName);
    const dbStatus = status === "ready" ? "running" : status;
    await db.query(
      `UPDATE processes SET status = $1, exit_code = $2, stopped_at = CASE WHEN $1 IN ('stopped', 'exited') THEN CURRENT_TIMESTAMP ELSE stopped_at END WHERE id = $3`,
      [dbStatus, exitCode, processDbId],
    );
  } catch {
    // Best-effort DB update
  }
}

function startRuntimeService(input: {
  workspaceName: string;
  taskId: string;
  label: string;
  command: string;
  requestedCwd: string;
  absoluteCwd: string;
  env: NodeJS.ProcessEnv;
  readyPattern?: string;
  port?: number;
  healthcheck?: string;
}): RuntimeServiceRecord {
  const serviceId = `svc_${randomUUID().slice(0, 12)}`;
  const startedAt = new Date().toISOString();
  const service: RuntimeServiceRecord = {
    id: serviceId,
    workspace: input.workspaceName,
    task_id: input.taskId,
    label: input.label,
    command: input.command,
    cwd: input.requestedCwd,
    status: "running",
    pid: null,
    port: input.port ?? null,
    exit_code: null,
    started_at: startedAt,
    ended_at: null,
    absolute_cwd: input.absoluteCwd,
    stop_requested: false,
    next_seq: 1,
    logs: [],
    listeners: new Set<RuntimeServiceListener>(),
    _child: null,
  };

  const store = getWorkspaceServiceStore(input.workspaceName, true);
  store.set(service.id, service);

  const child = spawnShellCommand({
    command: input.command,
    cwd: input.absoluteCwd,
    env: input.env,
    stdio: "pipe",
  });
  service.pid = typeof child.pid === "number" ? child.pid : null;
  service._child = child;

  let readyPatternRegex: RegExp | null = null;
  if (input.readyPattern) {
    try {
      readyPatternRegex = new RegExp(input.readyPattern);
    } catch {
      // Invalid regex - ignore.
    }
  }

  const checkReadyPattern = (text: string): void => {
    if (readyPatternRegex && service.status === "running") {
      if (readyPatternRegex.test(text)) {
        readyPatternRegex = null;
        updateRuntimeServiceStatus(service, "ready", null);
      }
    }
  };

  child.stdout?.on("data", (chunk) => {
    const text = String(chunk ?? "");
    appendRuntimeServiceLog(service, "stdout", text);
    checkReadyPattern(text);
  });
  child.stderr?.on("data", (chunk) => {
    const text = String(chunk ?? "");
    appendRuntimeServiceLog(service, "stderr", text);
    checkReadyPattern(text);
  });
  child.on("error", (error) => {
    appendRuntimeServiceLog(service, "system", `[spawn error] ${errorMessage(error)}\n`);
    if (service.status === "running" || service.status === "ready") {
      updateRuntimeServiceStatus(service, service.stop_requested ? "stopped" : "exited", -1);
    }
  });
  child.on("exit", (code) => {
    if (service.status !== "running" && service.status !== "ready") {
      return;
    }
    updateRuntimeServiceStatus(service, service.stop_requested ? "stopped" : "exited", code ?? -1);
  });

  appendRuntimeServiceLog(
    service,
    "system",
    `[started] ${input.command} (cwd=${input.requestedCwd})\n`,
  );
  publishRuntimeServiceEvent(service, {
    type: "status",
    service: toRuntimeServiceSummary(service),
  });

  return service;
}

function stopRuntimeService(service: RuntimeServiceRecord): void {
  if (service.status !== "running" && service.status !== "ready") {
    return;
  }

  service.stop_requested = true;
  appendRuntimeServiceLog(service, "system", "[stopping] SIGTERM\n");
  const pid = service.pid;
  if (!pid || pid <= 0) {
    updateRuntimeServiceStatus(service, "stopped", service.exit_code ?? -1);
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    updateRuntimeServiceStatus(service, "stopped", service.exit_code ?? -1);
    return;
  }

  setTimeout(() => {
    if (service.status !== "running" && service.status !== "ready") {
      return;
    }
    appendRuntimeServiceLog(service, "system", "[stopping] SIGKILL\n");
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      updateRuntimeServiceStatus(service, "stopped", service.exit_code ?? -1);
    }
  }, 5000);
}

async function recoverOrphanedTasks(): Promise<void> {
  const workspaces = await listWorkspaceNames();
  for (const workspaceName of workspaces) {
    const db = await openDatabase(workspaceName);

    // 1. Fail all orphaned running turns (chat, plan, and execute threads)
    const orphanedTurns = await db.query<{ id: string; thread_id: string }>(
      `SELECT ct.id, ct.thread_id
       FROM conversation_turns ct
       WHERE ct.status = 'running'`,
    );
    for (const turn of orphanedTurns.rows) {
      await failTurn(db, turn.id, "Server restarted while turn was in progress");
      await insertEvent(db, {
        id: `evt_${randomUUID().slice(0, 12)}`,
        threadId: turn.thread_id,
        turnId: turn.id,
        eventName: "error",
        payload: { code: "SERVER_RESTART", message: "Server restarted while turn was in progress" },
      });
    }

    // 2. Fail orphaned tasks in active execution states
    await db.query(
      `UPDATE tasks
       SET status = 'failed',
           completed_at = CURRENT_TIMESTAMP
       WHERE status IN ('running', 'orchestrating', 'queued')`,
    );

    if (orphanedTurns.rows.length > 0) {
      console.log(
        `[recovery] ${workspaceName}: failed ${orphanedTurns.rows.length} orphaned turn(s)`,
      );
    }
  }
}

async function recoverOrphanedProcesses(): Promise<void> {
  const workspaces = await listWorkspaceNames();
  for (const workspaceName of workspaces) {
    const db = await openDatabase(workspaceName);
    const running = await db.query<{ id: string; pid: number | null }>(
      `SELECT id, pid FROM processes WHERE status = 'running'`,
    );

    for (const row of running.rows) {
      const pid = row.pid;
      let alive = false;
      if (pid && pid > 0) {
        try {
          process.kill(pid, 0);
          alive = true;
        } catch {
          alive = false;
        }
      }

      if (alive && pid) {
        try {
          process.kill(pid, "SIGTERM");
        } catch {
          // already dead
        }
        // Give it a moment, then SIGKILL
        setTimeout(() => {
          try {
            process.kill(pid, 0);
            process.kill(pid, "SIGKILL");
          } catch {
            // already dead
          }
        }, 3000);
      }

      await db.query(
        `UPDATE processes SET status = 'exited', stopped_at = CURRENT_TIMESTAMP, exit_code = -1 WHERE id = $1`,
        [row.id],
      );
    }

    if (running.rows.length > 0) {
      console.log(
        `[recovery] ${workspaceName}: cleaned up ${running.rows.length} orphaned process(es)`,
      );
    }
  }
}

export async function startServer(options: StartServerOptions): Promise<void> {
  await setupPragma();
  await recoverOrphanedTasks();
  await recoverOrphanedProcesses();
  const apiUrl = process.env.PRAGMA_API_URL?.trim() || `http://127.0.0.1:${options.port}`;
  const pragmaCliCommand = resolvePragmaCliCommand(__dirname);
  const executeRunner = new ExecuteRunner({
    apiUrl,
    pragmaCliCommand,
    onTaskStatusChanged: (input) => {
      publishTaskStatus(input.workspaceName, {
        task_id: input.taskId,
        thread_id: input.threadId || undefined,
        status: input.status,
        changed_at: new Date().toISOString(),
        source: input.source,
      });
    },
    onThreadUpdated: (input) => {
      publishThreadUpdated(input.workspaceName, input.threadId, input.source);
    },
  });

  const app = new Hono<WorkspaceEnv>();

  // Only allow requests from localhost / 127.0.0.1 origins (the Pragma UI).
  app.use(
    "*",
    cors({
      origin: (origin) => {
        if (!origin) return "";
        try {
          const url = new URL(origin);
          if (url.hostname === "127.0.0.1" || url.hostname === "localhost") {
            return origin;
          }
        } catch {
          // invalid origin
        }
        return "";
      },
    }),
  );
  const emitTaskStatus = (
    workspaceName: string,
    taskId: string,
    status: TaskStatus,
    source: string,
  ): void => {
    publishTaskStatus(workspaceName, {
      task_id: taskId,
      status,
      changed_at: new Date().toISOString(),
      source,
    });
  };

  // Workspace middleware: provides c.get("db") and c.get("workspace") for all workspace-scoped routes
  app.use("/agents/*", workspaceMiddleware);
  app.use("/humans/*", workspaceMiddleware);
  app.use("/tasks/*", workspaceMiddleware);
  app.use("/conversations/*", workspaceMiddleware);
  app.use("/skills/*", workspaceMiddleware);
  app.use("/connectors/*", workspaceMiddleware);
  app.use("/db/*", workspaceMiddleware);
  app.use("/uploads", workspaceMiddleware);
  app.use("/services/*", workspaceMiddleware);
  app.use("/code/*", workspaceMiddleware);
  app.use("/context/*", workspaceMiddleware);
  app.use("/context", workspaceMiddleware);
  app.use("/workspace/outputs/*", workspaceMiddleware);
  app.use("/workspace/outputs/files", workspaceMiddleware);
  app.use("/processes*", workspaceMiddleware);

  const turnRunner = new TurnRunner({
    apiUrl,
    pragmaCliCommand,
    onThreadUpdated: (input) => {
      publishThreadUpdated(input.workspaceName, input.threadId, input.source);
    },
    onTaskStatusChanged: (input) => {
      publishTaskStatus(input.workspaceName, {
        task_id: input.taskId,
        thread_id: input.threadId,
        status: input.status as TaskStatus,
        changed_at: new Date().toISOString(),
        source: input.source,
      });
    },
    getAgentRow: getAgentById,
    listPlanWorkerCandidates: (db) => listPlanWorkerCandidates(db, DEFAULT_AGENT_ID),
    isDirectoryEmpty,
    getStoredPlanRecipientForTurn,
    buildConversationAgentEnv,
    emitTaskStatus,
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/cli/available", async (c) => {
    const execFileAsync = promisify(execFile);
    const whichCommand = process.platform === "win32" ? "where" : "which";

    const clis = allAdapterDefinitions().map((def) => ({
      id: def.id,
      command: def.command,
      available: false,
      models: Object.keys(def.models),
      globalSkillsDirs: def.globalSkillsDirs ?? [],
      mcpConfigFiles: def.mcpConfigFiles ?? [],
      titleModelId: def.titleModelId ?? null,
    }));

    await Promise.all(
      clis.map(async (cli) => {
        try {
          await execFileAsync(whichCommand, [cli.command]);
          cli.available = true;
        } catch {
          cli.available = false;
        }
      }),
    );

    return c.json({ clis });
  });

  app.post("/setup", async (c) => {
    await setupPragma();
    return c.json({ ok: true });
  });

  app.post("/db/query", validateJson(dbQuerySchema), async (c) => {
    const body = c.req.valid("json");
    const sql = body.sql.trim();

    // Only allow SELECT statements (read-only)
    const normalized = sql.replace(/^[\s(]+/, "").toUpperCase();
    if (!normalized.startsWith("SELECT") && !normalized.startsWith("WITH") && !normalized.startsWith("EXPLAIN")) {
      return c.json({ error: "Only SELECT, WITH, and EXPLAIN statements are allowed." }, 400);
    }

    const db = c.get("db");
    try {
      const result = await db.query(sql, body.params ?? []);
      return c.json({
        rows: result.rows,
        rowCount: result.rows.length,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return c.json({ error: message }, 400);
    }
  });

  app.post("/uploads", async (c) => {
    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

    const workspaceName = c.get("workspace");
    const paths = getWorkspacePaths(workspaceName);

    let formData: Awaited<ReturnType<typeof c.req.formData>>;
    try {
      formData = await c.req.formData();
    } catch (error: unknown) {
      throw new PragmaError("INVALID_UPLOAD", 400, errorMessage(error));
    }

    const fileEntry = formData.get("file");
    if (!isUploadedFile(fileEntry)) {
      throw new PragmaError("INVALID_UPLOAD", 400, "No file was provided.");
    }

    const buffer = Buffer.from(await fileEntry.arrayBuffer());
    if (buffer.length > MAX_FILE_SIZE) {
      throw new PragmaError("FILE_TOO_LARGE", 400, "File exceeds the 50MB size limit.");
    }

    const rawName = (fileEntry as { name?: string }).name || "file";
    const sanitized = rawName.replace(/[^a-zA-Z0-9._-]/g, "_");
    const uniqueName = `${Date.now()}-${sanitized}`;

    await mkdir(paths.uploadsDir, { recursive: true });
    const dest = join(paths.uploadsDir, uniqueName);
    await writeFile(dest, buffer);

    return c.json({ path: dest, name: rawName }, 201);
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

  app.post("/workspaces", validateJson(createWorkspaceSchema), async (c) => {
    const body = c.req.valid("json");

    await createWorkspace({ name: body.name, orchestrator_harness: body.orchestrator_harness });

    return c.json({
      ok: true,
      workspace: { name: body.name, active: true },
    });
  });

  app.post("/workspaces/active", validateJson(setActiveWorkspaceSchema), async (c) => {
    const body = c.req.valid("json");

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
    const db = c.get("db");
    const rows = await listAgents(db);
    return c.json({ agents: rows });
  });

  app.post("/agents", validateJson(createAgentSchema), async (c) => {
    const db = c.get("db");
    const body = c.req.valid("json");

    const harness = body.harness;
    const modelLabel = body.model_label;
    const modelId = resolveModelId(harness, modelLabel);
    const agentId = await generateNextAgentId(db, body.name);

    try {
      await insertAgent(db, {
        id: agentId,
        name: body.name,
        description: body.description ?? null,
        agent_file: body.agent_file,
        emoji: body.emoji,
        harness,
        model_label: modelLabel,
        model_id: modelId,
      });
      return c.json({ ok: true, id: agentId }, 201);
    } catch (error: unknown) {
      throw new PragmaError("CREATE_AGENT_FAILED", 400, errorMessage(error));
    }
  });

  app.put("/agents/:id", validateJson(updateAgentSchema), async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const modelId = resolveModelId(body.harness, body.model_label);
    const affected = await updateAgentStore(db, {
      id,
      name: body.name,
      description: body.description ?? null,
      agent_file: body.agent_file,
      emoji: body.emoji,
      harness: body.harness,
      model_label: body.model_label,
      model_id: modelId,
    });

    if (affected === 0) {
      throw new PragmaError("AGENT_NOT_FOUND", 404, `Agent not found: ${id}`);
    }
    return c.json({ ok: true });
  });

  app.delete("/agents/:id", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const affected = await deleteAgentStore(db, id);
    if (affected === 0) {
      throw new PragmaError("AGENT_NOT_FOUND", 404, `Agent not found: ${id}`);
    }
    return c.json({ ok: true });
  });

  // ── Agent Templates (GitHub catalog) ────────────────────────────────

  let agentTemplatesCache: { data: unknown[]; expiry: number } | null = null;
  const TEMPLATES_CACHE_TTL_MS = 10 * 60 * 1000;

  app.get("/agents/templates", async (c) => {
    const now = Date.now();
    if (agentTemplatesCache && agentTemplatesCache.expiry > now) {
      return c.json({ templates: agentTemplatesCache.data });
    }

    const EXCLUDED_PATHS = new Set(["README.md", "CONTRIBUTING.md", "LICENSE", "LICENSE.md"]);
    const EXCLUDED_DIRS = new Set(["examples", "strategy", "scripts", "integrations", ".github"]);

    try {
      const treeRes = await fetch(
        "https://api.github.com/repos/msitarzewski/agency-agents/git/trees/main?recursive=1",
        { headers: { Accept: "application/vnd.github.v3+json", "User-Agent": "pragma-server" } },
      );
      if (!treeRes.ok) {
        throw new PragmaError("GITHUB_API_ERROR", 502, `GitHub API returned ${treeRes.status}`);
      }

      const tree = (await treeRes.json()) as { tree: Array<{ path: string; type: string }> };
      const mdFiles = tree.tree.filter((entry) => {
        if (entry.type !== "blob" || !entry.path.endsWith(".md")) return false;
        // Exclude root-level files
        if (!entry.path.includes("/")) return false;
        // Exclude files in excluded directories
        const topDir = entry.path.split("/")[0];
        if (EXCLUDED_DIRS.has(topDir)) return false;
        // Exclude specific files at any level
        const fileName = entry.path.split("/").pop() ?? "";
        if (EXCLUDED_PATHS.has(fileName)) return false;
        return true;
      });

      const templates: Array<{
        name: string;
        description: string;
        emoji: string;
        category: string;
        content: string;
      }> = [];

      await Promise.all(
        mdFiles.map(async (file) => {
          try {
            const rawRes = await fetch(
              `https://raw.githubusercontent.com/msitarzewski/agency-agents/main/${file.path}`,
              { headers: { "User-Agent": "pragma-server" } },
            );
            if (!rawRes.ok) return;
            const text = await rawRes.text();

            // Parse YAML frontmatter between --- markers
            const fmMatch = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
            if (!fmMatch) return;

            const frontmatter = fmMatch[1];
            const body = text.slice(fmMatch[0].length).trim();

            // Simple YAML field extraction
            const getField = (key: string): string | undefined => {
              const m = frontmatter.match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
              return m ? m[1].trim().replace(/^["']|["']$/g, "") : undefined;
            };

            const name = getField("name");
            const description = getField("description");
            const emoji = getField("emoji");

            if (!name || !description || !emoji) return;

            const category = file.path.split("/")[0];
            templates.push({ name, description, emoji, category, content: body });
          } catch {
            // Skip files that fail to fetch/parse
          }
        }),
      );

      // Sort by category then name
      templates.sort((a, b) => a.category.localeCompare(b.category) || a.name.localeCompare(b.name));

      agentTemplatesCache = { data: templates, expiry: now + TEMPLATES_CACHE_TTL_MS };
      return c.json({ templates });
    } catch (error) {
      if (error instanceof PragmaError) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new PragmaError("TEMPLATES_FETCH_FAILED", 502, message);
    }
  });

  // ── Humans ──────────────────────────────────────────────────────────

  app.get("/humans", async (c) => {
    const db = c.get("db");
    const rows = await listHumans(db);
    return c.json({ humans: rows });
  });

  app.post("/humans", validateJson(createHumanSchema), async (c) => {
    const db = c.get("db");
    const body = c.req.valid("json");
    const id = randomUUID().slice(0, 12);

    try {
      await insertHuman(db, id, body.emoji);
      return c.json({ ok: true, id }, 201);
    } catch (error: unknown) {
      throw new PragmaError("CREATE_HUMAN_FAILED", 400, errorMessage(error));
    }
  });

  app.put("/humans/:id", validateJson(updateHumanSchema), async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const affected = await updateHumanStore(db, id, body.emoji);
    if (affected === 0) {
      throw new PragmaError("HUMAN_NOT_FOUND", 404, `Human not found: ${id}`);
    }
    return c.json({ ok: true });
  });

  app.delete("/humans/:id", async (c) => {
    const db = c.get("db");
    const id = c.req.param("id");
    const affected = await deleteHumanStore(db, id);
    if (affected === 0) {
      throw new PragmaError("HUMAN_NOT_FOUND", 404, `Human not found: ${id}`);
    }
    return c.json({ ok: true });
  });

  app.get("/tasks", validateQuery(tasksQuerySchema), async (c) => {
    const db = c.get("db");
    const { status, limit } = c.req.valid("query");
    const rows = await listTasks(db, { status, limit });

    return c.json({
      tasks: rows.map((row) => ({
        id: row.id,
        title: row.title,
        status: row.status,
        assigned_to: row.assigned_to,
        output_dir: row.output_dir,
        session_id: row.session_id,
        created_at: row.created_at,
        completed_at: row.completed_at,
        followup_task_id: row.followup_task_id,
        predecessor_task_id: row.predecessor_task_id,
        thread_id: row.thread_id,
        failure_message: extractTaskFailureMessage(row.failure_payload_json),
      })),
    });
  });

  app.get("/tasks/stream", async (c) => {
    const workspaceName = c.get("workspace");

    return createSSEStream(c, {
      setup: async (writeEvent) => {
        await writeEvent("ready", { workspace: workspaceName, ts: new Date().toISOString() });
        return subscribeTaskStatus(workspaceName, (event) => {
          void writeEvent("task_status_changed", event);
        });
      },
    });
  });

  app.get("/services", async (c) => {
    const workspaceName = c.get("workspace");
    return c.json({ services: listRuntimeServices(workspaceName) });
  });

  app.post("/services/:serviceId/stop", async (c) => {
    const workspaceName = c.get("workspace");
    const serviceId = c.req.param("serviceId");
    const service = getRuntimeService(workspaceName, serviceId);
    if (!service) {
      throw new PragmaError("SERVICE_NOT_FOUND", 404, `Service not found: ${serviceId}`);
    }

    stopRuntimeService(service);
    return c.json({
      ok: true,
      service: toRuntimeServiceSummary(service),
    });
  });

  app.get("/services/:serviceId/stream", async (c) => {
    const workspaceName = c.get("workspace");
    const serviceId = c.req.param("serviceId");
    const service = getRuntimeService(workspaceName, serviceId);
    if (!service) {
      throw new PragmaError("SERVICE_NOT_FOUND", 404, `Service not found: ${serviceId}`);
    }

    return createSSEStream(c, {
      setup: async (writeEvent) => {
        await writeEvent("ready", {
          service: toRuntimeServiceSummary(service),
          logs: service.logs,
          ts: new Date().toISOString(),
        });

        const listener: RuntimeServiceListener = (event) => {
          if (event.type === "log") {
            void writeEvent("log", { entry: event.entry });
            return;
          }
          void writeEvent("status", { service: event.service });
        };
        service.listeners.add(listener);

        return () => service.listeners.delete(listener);
      },
    });
  });

  // ── Process Management ─────────────────────────────────────────
  app.get("/processes", async (c) => {
    const workspaceName = c.get("workspace");
    const db = c.get("db");
    const result = await db.query(
      `SELECT * FROM processes WHERE workspace = $1 ORDER BY created_at DESC`,
      [workspaceName],
    );
    return c.json({ processes: result.rows });
  });

  app.get("/code/folders/:folderName/processes", async (c) => {
    const workspaceName = c.get("workspace");
    const folderName = c.req.param("folderName");
    const db = c.get("db");
    const result = await db.query(
      `SELECT * FROM processes WHERE workspace = $1 AND folder_name = $2 ORDER BY created_at DESC`,
      [workspaceName, folderName],
    );
    return c.json({ processes: result.rows });
  });

  app.post(
    "/code/folders/:folderName/processes",
    validateJson(createProcessSchema),
    async (c) => {
      const workspaceName = c.get("workspace");
      const folderName = c.req.param("folderName");
      const db = c.get("db");
      const body = c.req.valid("json");

      const processId = `proc_${randomUUID().slice(0, 12)}`;
      await db.query(
        `INSERT INTO processes (id, workspace, folder_name, label, command, cwd, type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'stopped')`,
        [processId, workspaceName, folderName, body.label, body.command, body.cwd, body.type],
      );

      const result = await db.query(`SELECT * FROM processes WHERE id = $1`, [processId]);
      return c.json({ ok: true, process: result.rows[0] }, 201);
    },
  );

  app.put(
    "/processes/:processId",
    validateJson(updateProcessSchema),
    async (c) => {
      const db = c.get("db");
      const processId = c.req.param("processId");
      const body = c.req.valid("json");

      const existing = await db.query<{ status: string }>(
        `SELECT status FROM processes WHERE id = $1`,
        [processId],
      );
      if (existing.rows.length === 0) {
        throw new PragmaError("PROCESS_NOT_FOUND", 404, `Process not found: ${processId}`);
      }
      if (existing.rows[0].status === "running") {
        throw new PragmaError("PROCESS_RUNNING", 400, "Cannot update a running process.");
      }

      const updates: string[] = [];
      const params: unknown[] = [];
      let paramIndex = 1;

      if (body.label !== undefined) { updates.push(`label = $${paramIndex++}`); params.push(body.label); }
      if (body.command !== undefined) { updates.push(`command = $${paramIndex++}`); params.push(body.command); }
      if (body.cwd !== undefined) { updates.push(`cwd = $${paramIndex++}`); params.push(body.cwd); }
      if (body.type !== undefined) { updates.push(`type = $${paramIndex++}`); params.push(body.type); }

      if (updates.length === 0) {
        const result = await db.query(`SELECT * FROM processes WHERE id = $1`, [processId]);
        return c.json({ ok: true, process: result.rows[0] });
      }

      params.push(processId);
      await db.query(
        `UPDATE processes SET ${updates.join(", ")} WHERE id = $${paramIndex}`,
        params,
      );

      const result = await db.query(`SELECT * FROM processes WHERE id = $1`, [processId]);
      return c.json({ ok: true, process: result.rows[0] });
    },
  );

  app.delete("/processes/:processId", async (c) => {
    const workspaceName = c.get("workspace");
    const db = c.get("db");
    const processId = c.req.param("processId");

    const existing = await db.query<{ status: string }>(
      `SELECT status FROM processes WHERE id = $1`,
      [processId],
    );
    if (existing.rows.length === 0) {
      throw new PragmaError("PROCESS_NOT_FOUND", 404, `Process not found: ${processId}`);
    }

    // Stop if running
    if (existing.rows[0].status === "running") {
      const store = getWorkspaceServiceStore(workspaceName);
      for (const service of store.values()) {
        if (service.process_db_id === processId) {
          stopRuntimeService(service);
          break;
        }
      }
    }

    await db.query(`DELETE FROM processes WHERE id = $1`, [processId]);
    return c.json({ ok: true });
  });

  app.post("/processes/:processId/start", async (c) => {
    const workspaceName = c.get("workspace");
    const db = c.get("db");
    const processId = c.req.param("processId");
    const workspacePaths = getWorkspacePaths(workspaceName);

    const result = await db.query<{
      id: string; folder_name: string; label: string; command: string;
      cwd: string; type: string; status: string;
    }>(
      `SELECT * FROM processes WHERE id = $1`,
      [processId],
    );
    if (result.rows.length === 0) {
      throw new PragmaError("PROCESS_NOT_FOUND", 404, `Process not found: ${processId}`);
    }

    const proc = result.rows[0];
    if (proc.status === "running") {
      throw new PragmaError("PROCESS_ALREADY_RUNNING", 400, "Process is already running.");
    }

    const absoluteCwd = join(workspacePaths.codeDir, proc.folder_name, proc.cwd === "." ? "" : proc.cwd);
    const cwdInfo = await stat(absoluteCwd).catch(() => null);
    if (!cwdInfo?.isDirectory()) {
      throw new PragmaError("PROCESS_CWD_NOT_FOUND", 400, `Working directory not found: ${absoluteCwd}`);
    }

    const service = startRuntimeService({
      workspaceName,
      taskId: "",
      label: proc.label,
      command: proc.command,
      requestedCwd: proc.cwd,
      absoluteCwd,
      env: { ...process.env, PRAGMA_WORKSPACE_NAME: workspaceName },
    });
    service.process_db_id = processId;

    await db.query(
      `UPDATE processes SET status = 'running', pid = $1, started_at = CURRENT_TIMESTAMP, stopped_at = NULL, exit_code = NULL WHERE id = $2`,
      [service.pid, processId],
    );

    return c.json({ ok: true, service: toRuntimeServiceSummary(service) });
  });

  app.post("/processes/:processId/stop", async (c) => {
    const workspaceName = c.get("workspace");
    const db = c.get("db");
    const processId = c.req.param("processId");

    const result = await db.query<{ id: string; status: string }>(
      `SELECT id, status FROM processes WHERE id = $1`,
      [processId],
    );
    if (result.rows.length === 0) {
      throw new PragmaError("PROCESS_NOT_FOUND", 404, `Process not found: ${processId}`);
    }

    const store = getWorkspaceServiceStore(workspaceName);
    for (const service of store.values()) {
      if (service.process_db_id === processId) {
        stopRuntimeService(service);
        return c.json({ ok: true, service: toRuntimeServiceSummary(service) });
      }
    }

    // Not in memory — just update DB
    await db.query(
      `UPDATE processes SET status = 'stopped', stopped_at = CURRENT_TIMESTAMP WHERE id = $1`,
      [processId],
    );
    return c.json({ ok: true });
  });

  app.post("/code/folders/:folderName/processes/detect", async (c) => {
    const workspaceName = c.get("workspace");
    const folderName = c.req.param("folderName");
    const db = c.get("db");
    const workspacePaths = getWorkspacePaths(workspaceName);
    const folderPath = join(workspacePaths.codeDir, folderName);

    const folderInfo = await stat(folderPath).catch(() => null);
    if (!folderInfo?.isDirectory()) {
      throw new PragmaError("CODE_FOLDER_NOT_FOUND", 404, `Code folder not found: ${folderName}`);
    }

    // Run detection async
    void detectProcessCommands(workspaceName, folderName, workspacePaths, db);
    return c.json({ ok: true, detecting: true });
  });

  // Read-only SSE event stream for a conversation thread.
  // Replays missed events using Last-Event-ID (the seq number),
  // then tails new events via the in-memory pub/sub.
  app.get("/conversations/:threadId/stream", async (c) => {
    const workspaceName = c.get("workspace");
    const threadId = c.req.param("threadId");
    const db = c.get("db");

    await ensureConversationSchema(db);
    const thread = await getThreadById(db, threadId);
    if (!thread) {
      throw new PragmaError("THREAD_NOT_FOUND", 404, `Conversation thread not found: ${threadId}`);
    }

    // Parse Last-Event-ID for reconnection replay
    const lastEventId = c.req.header("last-event-id");
    let lastSeq = 0;
    if (lastEventId) {
      const parsed = parseInt(lastEventId, 10);
      if (!isNaN(parsed) && parsed > 0) {
        lastSeq = parsed;
      }
    }

    return createSSEStream(c, {
      setup: async (writeEvent) => {
        // Replay missed events from the DB
        const replayDb = await openDatabase(workspaceName);
        try {
          await ensureConversationSchema(replayDb);
          const missedEvents = await getEventsSince(replayDb, threadId, lastSeq);
          for (const evt of missedEvents) {
            const payload = JSON.parse(evt.payload_json);
            await writeEvent(evt.event_name, payload, evt.seq);
            lastSeq = evt.seq;
          }
        } finally {
          await replayDb.close();
        }

        await writeEvent("ready", { thread_id: threadId, ts: new Date().toISOString() });

        // Subscribe to live thread updates and forward new events
        const drainNewEvents = async (): Promise<void> => {
          const eventDb = await openDatabase(workspaceName);
          try {
            await ensureConversationSchema(eventDb);
            const events = await getEventsSince(eventDb, threadId, lastSeq);
            for (const evt of events) {
              lastSeq = evt.seq;
              const payload = JSON.parse(evt.payload_json);
              await writeEvent(evt.event_name, payload, evt.seq);
            }
          } finally {
            await eventDb.close();
          }
        };

        return subscribeThreadUpdates(workspaceName, threadId, (updateEvent) => {
          void drainNewEvents();
          void writeEvent("thread_updated", updateEvent);
        });
      },
    });
  });

  app.get("/tasks/:taskId/output/changes", async (c) => {
    const workspaceName = c.get("workspace");
    const taskId =c.req.param("taskId");
    const db = c.get("db");

    const taskResult = await db.query<{ id: string; status: string; git_state_json: string | null; changes_diff: string | null }>(
      `
SELECT id, status, git_state_json, changes_diff
FROM tasks
WHERE id = $1
LIMIT 1
`,
      [taskId],
    );
    const task = taskResult.rows[0];
    if (!task) {
      throw new PragmaError("TASK_NOT_FOUND", 404, `Task not found: ${taskId}`);
    }

    const workspacePaths = getWorkspacePaths(workspaceName);

    if ((task.status === "completed" || task.status === "cancelled") && task.changes_diff != null) {
      return c.json({
        roots: [join(workspacePaths.worktreesDir, taskId, "workspace")],
        repos: [],
        diff: task.changes_diff,
      });
    }

    const gitState = parseTaskGitState(task.git_state_json);
    if (!gitState) {
      throw new PragmaError(
        "TASK_GIT_STATE_MISSING",
        409,
        `Task has no git execution state: ${taskId}`,
      );
    }

    const repoDiffs = await buildRepoDiffEntries({
      workspacePaths,
      taskId,
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
      roots: [join(workspacePaths.worktreesDir, taskId, "workspace")],
      repos: repoDiffs,
      diff: combinedDiff,
    });
  });

  app.get("/tasks/:taskId/output/files", async (c) => {
    const workspaceName = c.get("workspace");
    const taskId =c.req.param("taskId");
    const db = c.get("db");

    const workspacePaths = getWorkspacePaths(workspaceName);
    const outputsRoot = await getTaskOutputsRoot(db, workspacePaths, taskId);
    const files = await listOutputFiles(outputsRoot);

    return c.json({
      root: outputsRoot,
      files,
    });
  });

  app.get("/tasks/:taskId/output/file/content", validateQuery(outputFileQuerySchema), async (c) => {
    const workspaceName = c.get("workspace");
    const taskId =c.req.param("taskId");
    const { path: relativePath } = c.req.valid("query");
    const db = c.get("db");

    const workspacePaths = getWorkspacePaths(workspaceName);
    const outputsRoot = await getTaskOutputsRoot(db, workspacePaths, taskId);
    const { absolutePath, normalizedPath } = resolveOutputPath(outputsRoot, relativePath);
    const fileInfo = await stat(absolutePath).catch(() => null);
    if (!fileInfo?.isFile()) {
      throw new PragmaError("OUTPUT_FILE_NOT_FOUND", 404, `Output file not found: ${normalizedPath}`);
    }

    const mime = lookupMimeType(absolutePath);
    if (!mime) {
      throw new PragmaError("OUTPUT_MIME_TYPE_UNKNOWN", 409, `Unknown mime type for ${normalizedPath}`);
    }
    const content = await readFile(absolutePath);
    return c.body(content, 200, {
      "content-type": mime,
      "content-disposition": `inline; filename="${basename(absolutePath)}"`,
      "cache-control": "no-store",
    });
  });

  app.get("/tasks/:taskId/output/file/download", validateQuery(outputFileQuerySchema), async (c) => {
    const workspaceName = c.get("workspace");
    const taskId =c.req.param("taskId");
    const { path: relativePath } = c.req.valid("query");
    const db = c.get("db");

    const workspacePaths = getWorkspacePaths(workspaceName);
    const outputsRoot = await getTaskOutputsRoot(db, workspacePaths, taskId);
    const { absolutePath, normalizedPath } = resolveOutputPath(outputsRoot, relativePath);
    const fileInfo = await stat(absolutePath).catch(() => null);
    if (!fileInfo?.isFile()) {
      throw new PragmaError("OUTPUT_FILE_NOT_FOUND", 404, `Output file not found: ${normalizedPath}`);
    }

    const mime = lookupMimeType(absolutePath);
    if (!mime) {
      throw new PragmaError("OUTPUT_MIME_TYPE_UNKNOWN", 409, `Unknown mime type for ${normalizedPath}`);
    }
    const content = await readFile(absolutePath);
    return c.body(content, 200, {
      "content-type": mime,
      "content-disposition": `attachment; filename="${basename(absolutePath)}"`,
      "cache-control": "no-store",
    });
  });

  app.post("/tasks/:taskId/output/open-folder", validateJson(openOutputFolderSchema), async (c) => {
    const workspaceName = c.get("workspace");
    const taskId =c.req.param("taskId");
    const body = c.req.valid("json");

    const db = c.get("db");
    const workspacePaths = getWorkspacePaths(workspaceName);
    const outputsRoot = await getTaskOutputsRoot(db, workspacePaths, taskId);

    let targetPath = outputsRoot;
    if (body.path) {
      const { absolutePath } = resolveOutputPath(outputsRoot, body.path);
      const fileInfo = await stat(absolutePath).catch(() => null);
      if (!fileInfo) {
        throw new PragmaError("OUTPUT_PATH_NOT_FOUND", 404, "Output path does not exist.");
      }
      targetPath = fileInfo.isDirectory() ? absolutePath : dirname(absolutePath);
    }

    await openFolder(targetPath);
    return c.json({ ok: true, path: targetPath });
  });

  app.get("/tasks/:taskId/plan", async (c) => {
    const workspaceName = c.get("workspace");
    const taskId = c.req.param("taskId");
    const db = c.get("db");

    const result = await db.query<{ plan: string | null }>(
      `SELECT plan FROM tasks WHERE id = $1 LIMIT 1`,
      [taskId],
    );
    const plan = result.rows[0]?.plan?.trim() || null;
    return c.json({ plan });
  });

  app.get("/tasks/:taskId/test-commands", async (c) => {
    const workspaceName = c.get("workspace");
    const taskId =c.req.param("taskId");
    const db = c.get("db");

    const result = await db.query<{ id: string; test_commands_json: string | null }>(
      `
SELECT id, test_commands_json
FROM tasks
WHERE id = $1
LIMIT 1
`,
      [taskId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new PragmaError("TASK_NOT_FOUND", 404, `Task not found: ${taskId}`);
    }

    return c.json({
      commands: parseTaskTestCommands(row.test_commands_json),
    });
  });

  app.put(
    "/tasks/:taskId/test-commands",
    validateJson(updateTaskTestCommandsSchema),
    async (c) => {
      const workspaceName = c.get("workspace");
      const taskId =c.req.param("taskId");
      const body = c.req.valid("json");
      const db = c.get("db");

      const taskResult = await db.query<{ id: string }>(
        `
SELECT id
FROM tasks
WHERE id = $1
LIMIT 1
`,
        [taskId],
      );
      const task = taskResult.rows[0];
      if (!task) {
        throw new PragmaError("TASK_NOT_FOUND", 404, `Task not found: ${taskId}`);
      }

      const normalizedCommands = normalizeTaskTestCommands(body.commands);
      if (normalizedCommands.length === 0) {
        throw new PragmaError(
          "INVALID_TEST_COMMANDS",
          400,
          "No valid test commands were provided.",
        );
      }

      await db.query(
        `
UPDATE tasks
SET test_commands_json = $2
WHERE id = $1
`,
        [taskId, JSON.stringify(normalizedCommands)],
      );

      return c.json({
        ok: true,
        commands: normalizedCommands,
      });
    },
  );

  app.post("/tasks/:taskId/test-commands/run", validateJson(runTaskTestCommandSchema), async (c) => {
    const workspaceName = c.get("workspace");
    const taskId =c.req.param("taskId");
    const body = c.req.valid("json");
    const db = c.get("db");

    const result = await db.query<{
      id: string;
      test_commands_json: string | null;
    }>(
      `
SELECT id, test_commands_json
FROM tasks
WHERE id = $1
LIMIT 1
`,
      [taskId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new PragmaError("TASK_NOT_FOUND", 404, `Task not found: ${taskId}`);
    }

    const commands = parseTaskTestCommands(row.test_commands_json);
    const selected = commands.find(
      (item) => item.command === body.command && item.cwd === body.cwd,
    );
    if (!selected) {
      throw new PragmaError(
        "TEST_COMMAND_NOT_ALLOWED",
        409,
        "Test command is not registered for this task.",
      );
    }

    const workspacePaths = getWorkspacePaths(workspaceName);
    const runRoot = await resolveTaskExecutionRoot(workspacePaths, taskId);
    const commandCwd = await resolveTaskCommandCwd(runRoot, selected.cwd);
    const service = startRuntimeService({
      workspaceName,
      taskId,
      label: selected.label,
      command: selected.command,
      requestedCwd: selected.cwd,
      absoluteCwd: commandCwd,
      env: {
        ...process.env,
        PRAGMA_WORKSPACE_NAME: workspaceName,
        PRAGMA_TASK_ID: taskId,
      },
    });

    return c.json({
      ok: true,
      service: toRuntimeServiceSummary(service),
    });
  });

  app.post("/tasks/:taskId/review", validateJson(reviewTaskSchema), async (c) => {
    const workspaceName = c.get("workspace");
    const taskId =c.req.param("taskId");
    const body = c.req.valid("json");

    const db = c.get("db");
    await ensureConversationSchema(db);

    const taskResult = await db.query<{
      id: string;
      title: string;
      status: TaskStatus;
      assigned_to: string | null;
      merge_retry_count: number | null;
      git_state_json: string | null;
      predecessor_task_id: string | null;
      followup_task_id: string | null;
    }>(
      `
SELECT id, title, status, assigned_to, merge_retry_count, git_state_json, predecessor_task_id, followup_task_id
FROM tasks
WHERE id = $1
LIMIT 1
`,
      [taskId],
    );
    const task = taskResult.rows[0];
    if (!task) {
      throw new PragmaError("TASK_NOT_FOUND", 404, `Task not found: ${taskId}`);
    }

    const pushAfterMerge = body.action === "approve_and_push" || body.action === "approve_chain_and_push";

    if (body.action === "reopen") {
      if (task.status !== "completed") {
        throw new PragmaError(
          "TASK_NOT_COMPLETED",
          409,
          `Task is not completed: ${taskId}`,
        );
      }

      const thread = await getThreadByTaskId(db, taskId);
      if (!thread) {
        throw new PragmaError("TASK_THREAD_NOT_FOUND", 404, `No conversation thread found for task: ${taskId}`);
      }

      const latestExecuteTurn = await getLatestExecuteTurn(db, thread.id);
      if (!latestExecuteTurn || !latestExecuteTurn.user_message.trim()) {
        throw new PragmaError("NO_EXECUTE_PROMPT", 409, "No execute task prompt is available for this task.");
      }

      await db.query(
        `
UPDATE tasks
SET status = 'waiting_for_help_response',
    merge_retry_count = 0,
    completed_at = NULL
WHERE id = $1
`,
        [taskId],
      );
      emitTaskStatus(workspaceName, taskId, "waiting_for_help_response", "review_reopen");

      await insertEvent(db, {
        id: `evt_${randomUUID().slice(0, 12)}`,
        threadId: thread.id,
        turnId: latestExecuteTurn.id,
        eventName: "task_reopened",
        payload: {
          from_status: "completed",
        },
      });
      publishThreadUpdated(workspaceName, thread.id, "task_reopened");

      return c.json({
        ok: true,
        status: "waiting_for_help_response",
      });
    }

    if (body.action === "mark_completed") {
      if (task.status === "completed") {
        return c.json({
          ok: true,
          status: "completed",
          merge_state: "no_changes",
        });
      }

      if (task.status !== "pending_review") {
        throw new PragmaError(
          "TASK_NOT_PENDING_REVIEW",
          409,
          `Task is not pending review: ${taskId}`,
        );
      }

      const nextStatus: TaskStatus = "completed";
      const workspacePaths = getWorkspacePaths(workspaceName);
      await syncTaskOutputsBackToWorkspace({ workspacePaths, taskId });
      const mergedOutputDir = getTaskMainOutputDir(workspacePaths, taskId);
      await mkdir(mergedOutputDir, { recursive: true });
      await db.query(
        `
UPDATE tasks
SET status = $2,
    output_dir = $3,
    completed_at = CURRENT_TIMESTAMP
WHERE id = $1
`,
        [taskId, nextStatus, mergedOutputDir],
      );
      emitTaskStatus(workspaceName, taskId, nextStatus, "review_mark_completed");
      executeRunner.abort(taskId);
      await deleteTaskWorktree({ workspacePaths, taskId });

      return c.json({
        ok: true,
        status: nextStatus,
        merge_state: "no_changes",
      });
    }

    if (body.action === "mark_chain_completed") {
      if (task.status !== "pending_review" && task.status !== "completed") {
        throw new PragmaError("TASK_NOT_PENDING_REVIEW", 409, `Task is not pending review: ${taskId}`);
      }

      const workspacePaths = getWorkspacePaths(workspaceName);
      const chainTaskIds = await walkPredecessorChain(db, taskId, task.predecessor_task_id);
      await completeChainTasks(db, workspacePaths, chainTaskIds, emitTaskStatus, executeRunner, workspaceName, "review_mark_chain_completed");

      return c.json({
        ok: true,
        status: "completed",
        merge_state: "no_changes",
        chain_completed: chainTaskIds,
      });
    }

    const isChainApprove = body.action === "approve_chain" || body.action === "approve_chain_and_push";

    if (isChainApprove) {
      if (task.status !== "pending_review") {
        throw new PragmaError("TASK_NOT_PENDING_REVIEW", 409, `Task is not pending review: ${taskId}`);
      }

      const gitState = parseTaskGitState(task.git_state_json);
      if (!gitState) {
        // No git state — output-files-only chain approval, mark all chain tasks completed
        const workspacePaths = getWorkspacePaths(workspaceName);
        const chainTaskIds = await walkPredecessorChain(db, taskId, task.predecessor_task_id);
        await completeChainTasks(db, workspacePaths, chainTaskIds, emitTaskStatus, executeRunner, workspaceName, "review_chain_action");
        return c.json({
          ok: true,
          status: "completed",
          merge_state: "no_changes",
          chain_completed: chainTaskIds,
        });
      }

      const workspacePaths = getWorkspacePaths(workspaceName);
      const chainTaskIds = await walkPredecessorChain(db, taskId, task.predecessor_task_id);

      // Merge only the current (last) task's branch — it has all cumulative commits
      const mergeResult = await mergeApprovedTask({
        workspacePaths,
        taskId,
        taskTitle: task.title,
        gitState,
      });

      if (mergeResult.conflicts.length === 0) {
        // Mark all chain tasks as completed
        for (const chainId of chainTaskIds) {
          const mergedOutputDir = getTaskMainOutputDir(workspacePaths, chainId);
          await db.query(
            `UPDATE tasks SET status = 'completed', output_dir = $2, completed_at = CURRENT_TIMESTAMP WHERE id = $1`,
            [chainId, mergedOutputDir],
          );
          emitTaskStatus(workspaceName, chainId, "completed", "review_chain_action");
        }

        await saveDiffSnapshot({ db, workspacePaths, taskId, gitState });

        for (const chainId of chainTaskIds) {
          executeRunner.abort(chainId);
          await deleteTaskWorktree({ workspacePaths, taskId: chainId });
        }

        if (pushAfterMerge) {
          await pushReposToOrigin(gitState, workspacePaths);
        }

        return c.json({
          ok: true,
          status: "completed",
          merge_state: pushAfterMerge ? "merged_and_pushed" : "merged",
          conflicts: [],
          chain_completed: chainTaskIds,
        });
      }

      // Merge conflicts — use same retry logic as normal approve
      const retryResult = await handleMergeConflictRetry({
        db, workspacePaths, taskId, gitState, task, mergeConflicts: mergeResult.conflicts,
        pushAfterMerge, workspaceName, emitTaskStatus, executeRunner, statusSource: "review_chain_conflict_retry",
      });
      if (retryResult.outcome === "retried") {
        return c.json(retryResult.response);
      }

      await db.query(`UPDATE tasks SET status = 'needs_fix' WHERE id = $1`, [taskId]);
      emitTaskStatus(workspaceName, taskId, "needs_fix", "review_chain_conflict_manual");
      return c.json({
        ok: true,
        status: "needs_fix",
        merge_state: "manual_intervention_required",
        conflicts: mergeResult.conflicts,
      });
    }

    if (task.status !== "pending_review") {
      throw new PragmaError(
        "TASK_NOT_PENDING_REVIEW",
        409,
        `Task is not pending review: ${taskId}`,
      );
    }

    const gitState = parseTaskGitState(task.git_state_json);
    if (!gitState) {
      // No git state — output-files-only approval, just mark completed
      const nextStatus: TaskStatus = "completed";
      const workspacePaths = getWorkspacePaths(workspaceName);
      await syncTaskOutputsBackToWorkspace({ workspacePaths, taskId });
      const mergedOutputDir = getTaskMainOutputDir(workspacePaths, taskId);
      await mkdir(mergedOutputDir, { recursive: true });
      await db.query(
        `UPDATE tasks SET status = $2, output_dir = $3, completed_at = CURRENT_TIMESTAMP WHERE id = $1`,
        [taskId, nextStatus, mergedOutputDir],
      );
      emitTaskStatus(workspaceName, taskId, nextStatus, "review_action");
      executeRunner.abort(taskId);
      await deleteTaskWorktree({ workspacePaths, taskId });
      return c.json({ ok: true, status: nextStatus, merge_state: "no_changes", conflicts: [] });
    }

    const workspacePaths = getWorkspacePaths(workspaceName);
    const mergeResult = await mergeApprovedTask({
      workspacePaths,
      taskId,
      taskTitle: task.title,
      gitState,
    });

    if (mergeResult.conflicts.length === 0) {
      const nextStatus: TaskStatus = "completed";
      const mergedOutputDir = getTaskMainOutputDir(workspacePaths, taskId);
      await db.query(
        `
UPDATE tasks
SET status = $2,
    output_dir = $3,
    completed_at = CURRENT_TIMESTAMP
WHERE id = $1
`,
        [taskId, nextStatus, mergedOutputDir],
      );
      emitTaskStatus(workspaceName, taskId, nextStatus, "review_action");
      await saveDiffSnapshot({ db, workspacePaths, taskId, gitState });
      executeRunner.abort(taskId);
      await deleteTaskWorktree({ workspacePaths, taskId });

      if (pushAfterMerge) {
        await pushReposToOrigin(gitState, workspacePaths);
      }

      return c.json({
        ok: true,
        status: nextStatus,
        merge_state: pushAfterMerge ? "merged_and_pushed" : "merged",
        conflicts: [],
      });
    }

    const retryResult = await handleMergeConflictRetry({
      db, workspacePaths, taskId, gitState, task, mergeConflicts: mergeResult.conflicts,
      pushAfterMerge, workspaceName, emitTaskStatus, executeRunner, statusSource: "review_conflict_retry",
    });
    if (retryResult.outcome === "retried") {
      return c.json(retryResult.response);
    }

    if (retryResult.outcome === "missing_context") {
      await db.query(
        `UPDATE tasks SET status = 'needs_fix', push_after_merge = FALSE WHERE id = $1`,
        [taskId],
      );
      emitTaskStatus(workspaceName, taskId, "needs_fix", "review_conflict_missing_retry_context");
      return c.json({
        ok: true,
        status: "needs_fix",
        merge_state: "manual_intervention_required",
        conflicts: mergeResult.conflicts,
      });
    }

    await db.query(
      `UPDATE tasks SET status = 'needs_fix' WHERE id = $1`,
      [taskId],
    );
    emitTaskStatus(workspaceName, taskId, "needs_fix", "review_conflict_manual");
    return c.json({
      ok: true,
      status: "needs_fix",
      merge_state: "manual_intervention_required",
      conflicts: mergeResult.conflicts,
    });
  });

  app.delete("/tasks/:taskId", async (c) => {
    const workspaceName = c.get("workspace");
    const taskId =c.req.param("taskId");

    const db = c.get("db");
    await ensureConversationSchema(db);

    const taskResult = await db.query<{
      id: string;
      status: TaskStatus;
    }>(
      `
SELECT id, status
FROM tasks
WHERE id = $1
LIMIT 1
`,
      [taskId],
    );
    const task = taskResult.rows[0];
    if (!task) {
      throw new PragmaError("TASK_NOT_FOUND", 404, `Task not found: ${taskId}`);
    }

    const workspacePaths = getWorkspacePaths(workspaceName);

    await db.query(
      `
UPDATE tasks
SET status = 'cancelled',
    completed_at = CURRENT_TIMESTAMP
WHERE id = $1
`,
      [taskId],
    );
    emitTaskStatus(workspaceName, taskId, "cancelled", "task_deleted");

    executeRunner.abort(taskId);
    await deleteTaskWorktree({ workspacePaths, taskId });
    await rm(getTaskMainOutputDir(workspacePaths, taskId), { recursive: true, force: true });

    return c.json({ ok: true, status: "cancelled" });
  });

  app.post("/tasks", validateJson(createTaskSchema), async (c) => {
    const workspaceName = c.get("workspace");
    const body = c.req.valid("json");

    const taskId =`task_${randomUUID().slice(0, 8)}`;
    const status: TaskStatus = body.status;
    const db = c.get("db");

    try {
      await db.query(
        `
INSERT INTO tasks (id, title, status, assigned_to, output_dir, session_id)
VALUES ($1, $2, $3, $4, $5, $6)
`,
        [
          taskId,
          body.title,
          status,
          body.assigned_to ?? null,
          body.output_dir ?? null,
          body.session_id ?? null,
        ],
      );
      emitTaskStatus(workspaceName, taskId, status, "task_created");
    } catch (error: unknown) {
      throw new PragmaError("CREATE_TASK_FAILED", 400, errorMessage(error));
    }

    return c.json({ id: taskId }, 201);
  });

  app.post("/tasks/execute", validateJson(createExecuteTaskSchema), async (c) => {
    const workspaceName = c.get("workspace");
    const body = c.req.valid("json");
    const prompt = body.prompt;
    const reasoningEffort = body.reasoning_effort;
    const fallbackTitle = prompt.length > 100 ? `${prompt.slice(0, 97)}...` : prompt;
    const taskId =`task_${randomUUID().slice(0, 8)}`;
    const threadId = `thread_${randomUUID().slice(0, 12)}`;

    const db = c.get("db");
    try {
      await ensureConversationSchema(db);

      const orchestrator = await getAgentById(db, DEFAULT_AGENT_ID);
      if (!orchestrator) {
        throw new PragmaError(
          "ORCHESTRATOR_NOT_FOUND",
          400,
          `Orchestrator agent is missing: ${DEFAULT_AGENT_ID}`,
        );
      }

      let requestedRecipientAgentId: string | null = null;
      if (body.recipient_agent_id) {
        requestedRecipientAgentId = body.recipient_agent_id;
        if (!requestedRecipientAgentId) {
          throw new PragmaError("INVALID_RECIPIENT", 400, "recipient_agent_id cannot be empty.");
        }

        const recipient = await getAgentById(db, requestedRecipientAgentId);
        if (!recipient || recipient.id === DEFAULT_AGENT_ID) {
          throw new PragmaError(
            "INVALID_RECIPIENT",
            400,
            `Invalid recipient agent id: ${requestedRecipientAgentId}`,
          );
        }
      }

      await db.query(
        `
INSERT INTO tasks (id, title, status, assigned_to, output_dir, session_id, plan)
VALUES ($1, $2, 'queued', NULL, NULL, NULL, $3)
`,
        [taskId, fallbackTitle, prompt],
      );
      emitTaskStatus(workspaceName, taskId, "queued", "execute_created");

      // Fire-and-forget: generate an AI title from the prompt
      generateTitle(db, prompt, "").then(async (aiTitle) => {
        await updateTaskTitle(db, taskId, aiTitle);
        const row = await db.query<{ status: TaskStatus }>(
          `SELECT status FROM tasks WHERE id = $1 LIMIT 1`,
          [taskId],
        );
        const currentStatus = row.rows[0]?.status;
        if (currentStatus) {
          emitTaskStatus(workspaceName, taskId, currentStatus, "title_generated");
        }
      }).catch(() => {});

      await createThread(db, {
        id: threadId,
        mode: "execute",
        harness: orchestrator.harness,
        modelLabel: orchestrator.model_label,
        modelId: orchestrator.model_id,
        sourceThreadId: null,
        taskId,
      });

      executeRunner.execute({
        workspaceName,
        taskId,
        threadId,
        prompt,
        requestedRecipientAgentId,
        reasoningEffort,
      });
    } catch (error: unknown) {
      if (error instanceof PragmaError) {
        throw error;
      }
      throw new PragmaError("CREATE_EXECUTE_TASK_FAILED", 400, errorMessage(error));
    }

    return c.json({ task_id: taskId }, 201);
  });

  app.post("/tasks/:taskId/followup", validateJson(createFollowupTaskSchema), async (c) => {
    const workspaceName = c.get("workspace");
    const parentTaskId = c.req.param("taskId");
    const body = c.req.valid("json");
    const prompt = body.prompt;
    const reasoningEffort = body.reasoning_effort;
    const fallbackTitle = prompt.length > 100 ? `${prompt.slice(0, 97)}...` : prompt;
    const newTaskId = `task_${randomUUID().slice(0, 8)}`;
    const threadId = `thread_${randomUUID().slice(0, 12)}`;

    const db = c.get("db");
    try {
      await ensureConversationSchema(db);

      const parentResult = await db.query<{
        id: string;
        status: TaskStatus;
        followup_task_id: string | null;
      }>(
        `SELECT id, status, followup_task_id FROM tasks WHERE id = $1 LIMIT 1`,
        [parentTaskId],
      );
      const parent = parentResult.rows[0];
      if (!parent) {
        throw new PragmaError("TASK_NOT_FOUND", 404, `Task not found: ${parentTaskId}`);
      }
      if (parent.followup_task_id) {
        throw new PragmaError(
          "FOLLOWUP_EXISTS",
          409,
          `Task ${parentTaskId} already has a follow-up task: ${parent.followup_task_id}`,
        );
      }

      const orchestrator = await getAgentById(db, DEFAULT_AGENT_ID);
      if (!orchestrator) {
        throw new PragmaError("ORCHESTRATOR_NOT_FOUND", 400, `Orchestrator agent is missing: ${DEFAULT_AGENT_ID}`);
      }

      let requestedRecipientAgentId: string | null = null;
      if (body.recipient_agent_id) {
        requestedRecipientAgentId = body.recipient_agent_id;
        const recipient = await getAgentById(db, requestedRecipientAgentId);
        if (!recipient || recipient.id === DEFAULT_AGENT_ID) {
          throw new PragmaError("INVALID_RECIPIENT", 400, `Invalid recipient agent id: ${requestedRecipientAgentId}`);
        }
      }

      await db.query(
        `INSERT INTO tasks (id, title, status, assigned_to, output_dir, session_id, plan, predecessor_task_id)
         VALUES ($1, $2, 'queued', NULL, NULL, NULL, $3, $4)`,
        [newTaskId, fallbackTitle, prompt, parentTaskId],
      );

      await db.query(
        `UPDATE tasks SET followup_task_id = $2 WHERE id = $1`,
        [parentTaskId, newTaskId],
      );

      emitTaskStatus(workspaceName, newTaskId, "queued", "followup_created");

      generateTitle(db, prompt, "").then(async (aiTitle) => {
        await updateTaskTitle(db, newTaskId, aiTitle);
        const row = await db.query<{ status: TaskStatus }>(
          `SELECT status FROM tasks WHERE id = $1 LIMIT 1`,
          [newTaskId],
        );
        const currentStatus = row.rows[0]?.status;
        if (currentStatus) {
          emitTaskStatus(workspaceName, newTaskId, currentStatus, "title_generated");
        }
      }).catch(() => {});

      await createThread(db, {
        id: threadId,
        mode: "execute",
        harness: orchestrator.harness,
        modelLabel: orchestrator.model_label,
        modelId: orchestrator.model_id,
        sourceThreadId: null,
        taskId: newTaskId,
      });

      // If parent is already pending_review or completed, start the follow-up immediately
      if (parent.status === "pending_review" || parent.status === "completed") {
        executeRunner.execute({
          workspaceName,
          taskId: newTaskId,
          threadId,
          prompt,
          requestedRecipientAgentId,
          reasoningEffort,
        });
      }
    } catch (error: unknown) {
      if (error instanceof PragmaError) {
        throw error;
      }
      throw new PragmaError("CREATE_FOLLOWUP_TASK_FAILED", 400, errorMessage(error));
    }

    return c.json({ task_id: newTaskId, parent_task_id: parentTaskId }, 201);
  });

  app.post("/tasks/:taskId/recipient", validateJson(setTaskRecipientSchema), async (c) => {
    const workspaceName = c.get("workspace");
    const taskId =c.req.param("taskId");
    const body = c.req.valid("json");
    const recipientAgentId = body.recipient_agent_id;
    const db = c.get("db");

    await ensureConversationSchema(db);
    const taskResult = await db.query<{ id: string; status: TaskStatus }>(
      `
SELECT id, status
FROM tasks
WHERE id = $1
LIMIT 1
`,
      [taskId],
    );
    const task = taskResult.rows[0];
    if (!task) {
      throw new PragmaError("TASK_NOT_FOUND", 404, `Task not found: ${taskId}`);
    }
    if (task.status !== "waiting_for_recipient") {
      throw new PragmaError(
        "TASK_NOT_WAITING_FOR_RECIPIENT",
        409,
        `Task is not waiting for recipient input: ${taskId}`,
      );
    }

    const recipient = await getAgentById(db, recipientAgentId);
    if (!recipient || recipient.id === DEFAULT_AGENT_ID) {
      throw new PragmaError("INVALID_RECIPIENT", 400, `Invalid recipient agent id: ${recipientAgentId}`);
    }

    const thread = await getThreadByTaskId(db, taskId);
    if (!thread) {
      throw new PragmaError("TASK_THREAD_NOT_FOUND", 404, `No conversation thread found for task: ${taskId}`);
    }

    const latestExecuteTurn = await getLatestExecuteTurn(db, thread.id);
    if (!latestExecuteTurn || !latestExecuteTurn.user_message.trim()) {
      throw new PragmaError("NO_EXECUTE_PROMPT", 409, "No execute task prompt is available for this task.");
    }

    await db.query(
      `
UPDATE tasks
SET status = 'queued'
WHERE id = $1
`,
      [taskId],
    );
    emitTaskStatus(workspaceName, taskId, "queued", "human_response");
    emitTaskStatus(workspaceName, taskId, "queued", "recipient_selected");

    executeRunner.execute({
      workspaceName,
      taskId,
      threadId: thread.id,
      prompt: latestExecuteTurn.user_message,
      requestedRecipientAgentId: recipientAgentId,
      reasoningEffort: requireReasoningEffort(
        latestExecuteTurn.reasoning_effort,
        `latest execute turn for task ${taskId}`,
      ),
    });

    return c.json({ ok: true });
  });

  app.post(
    "/tasks/:taskId/agent/select-recipient",
    validateJson(agentSelectRecipientSchema),
    async (c) => {
    const workspaceName = c.get("workspace");
    const taskId =c.req.param("taskId");
    const body = c.req.valid("json");
    const selectedAgentId = body.agent_id;
    const db = c.get("db");

    await ensureConversationSchema(db);
    const taskResult = await db.query<{ id: string; status: TaskStatus }>(
      `
SELECT id, status
FROM tasks
WHERE id = $1
LIMIT 1
`,
      [taskId],
    );
    const task = taskResult.rows[0];
    if (!task) {
      throw new PragmaError("TASK_NOT_FOUND", 404, `Task not found: ${taskId}`);
    }
    if (task.status !== "orchestrating") {
      throw new PragmaError(
        "TASK_NOT_ORCHESTRATING",
        409,
        `Task is not orchestrating: ${taskId}`,
      );
    }

    const recipient = await getAgentById(db, selectedAgentId);
    if (!recipient || recipient.id === DEFAULT_AGENT_ID) {
      throw new PragmaError("INVALID_RECIPIENT", 400, `Invalid recipient agent id: ${selectedAgentId}`);
    }

    await db.query(
      `
UPDATE tasks
SET assigned_to = $2
WHERE id = $1
`,
      [taskId, selectedAgentId],
    );


    return c.json({ ok: true, assigned_to: selectedAgentId });
  });

  app.post(
    "/tasks/:taskId/agent/test-commands",
    validateJson(agentSubmitTestCommandsSchema),
    async (c) => {
      const workspaceName = c.get("workspace");
      const taskId =c.req.param("taskId");
      const body = c.req.valid("json");

      const db = c.get("db");
      await ensureConversationSchema(db);
      const taskResult = await db.query<{
        id: string;
        status: TaskStatus;
        assigned_to: string | null;
        test_commands_json: string | null;
      }>(
        `
SELECT id, status, assigned_to, test_commands_json
FROM tasks
WHERE id = $1
LIMIT 1
`,
        [taskId],
      );
      const task = taskResult.rows[0];
      if (!task) {
        throw new PragmaError("TASK_NOT_FOUND", 404, `Task not found: ${taskId}`);
      }
      if (task.status !== "running" && task.status !== "pending_review") {
        throw new PragmaError(
          "TASK_NOT_ACCEPTING_TEST_COMMANDS",
          409,
          `Task cannot accept test commands in status: ${task.status}`,
        );
      }

      const normalizedCommands = normalizeTaskTestCommands(body.commands);
      if (normalizedCommands.length === 0) {
        throw new PragmaError(
          "INVALID_TEST_COMMANDS",
          400,
          "No valid test commands were provided.",
        );
      }

      const disallowed = normalizedCommands.find((entry) =>
        isDisallowedHumanOnlyTestCommand(entry.command),
      );
      if (disallowed) {
        throw new PragmaError(
          "INVALID_TEST_COMMAND_POLICY",
          400,
          `Disallowed command for task window: ${disallowed.command}`,
        );
      }

      const existingCommands = parseTaskTestCommands(task.test_commands_json);
      const combinedCommands = body.replace
        ? normalizedCommands
        : normalizeTaskTestCommands(
            [...existingCommands, ...normalizedCommands],
            Number.MAX_SAFE_INTEGER,
          ).slice(-8);

      await db.query(
        `
UPDATE tasks
SET test_commands_json = $2
WHERE id = $1
`,
        [taskId, JSON.stringify(combinedCommands)],
      );

      const thread = await getThreadByTaskId(db, taskId);
      if (thread) {
        const latestExecuteTurn = await getLatestExecuteTurn(db, thread.id);
        await insertEvent(db, {
          id: `evt_${randomUUID().slice(0, 12)}`,
          threadId: thread.id,
          turnId: body.turn_id || latestExecuteTurn?.id || null,
          eventName: "worker_test_commands_submitted",
          payload: {
            commands: combinedCommands,
            replace: Boolean(body.replace),
            agent_id: body.agent_id ?? task.assigned_to ?? null,
          },
        });
        publishThreadUpdated(workspaceName, thread.id, "worker_test_commands_submitted");
      }

      return c.json({
        ok: true,
        commands: combinedCommands,
      });
    },
  );

  app.post(
    "/tasks/:taskId/agent/testing-config",
    validateJson(agentSubmitTestingConfigSchema),
    async (c) => {
      const workspaceName = c.get("workspace");
      const taskId = c.req.param("taskId");
      const body = c.req.valid("json");

      const db = c.get("db");
      await ensureConversationSchema(db);
      const taskResult = await db.query<{
        id: string;
        status: TaskStatus;
        assigned_to: string | null;
      }>(
        `
SELECT id, status, assigned_to
FROM tasks
WHERE id = $1
LIMIT 1
`,
        [taskId],
      );
      const task = taskResult.rows[0];
      if (!task) {
        throw new PragmaError("TASK_NOT_FOUND", 404, `Task not found: ${taskId}`);
      }
      if (task.status !== "running" && task.status !== "pending_review") {
        throw new PragmaError(
          "TASK_NOT_ACCEPTING_TESTING_CONFIG",
          409,
          `Task cannot accept testing config in status: ${task.status}`,
        );
      }

      await db.query(
        `UPDATE tasks SET testing_config_json = $2 WHERE id = $1`,
        [taskId, JSON.stringify(body.config)],
      );

      const thread = await getThreadByTaskId(db, taskId);
      if (thread) {
        const latestExecuteTurn = await getLatestExecuteTurn(db, thread.id);
        await insertEvent(db, {
          id: `evt_${randomUUID().slice(0, 12)}`,
          threadId: thread.id,
          turnId: body.turn_id || latestExecuteTurn?.id || null,
          eventName: "worker_testing_config_submitted",
          payload: {
            config: body.config,
            agent_id: body.agent_id ?? task.assigned_to ?? null,
          },
        });
        publishThreadUpdated(workspaceName, thread.id, "worker_testing_config_submitted");
      }

      return c.json({ ok: true });
    },
  );

  app.get("/tasks/:taskId/testing-config", async (c) => {
    const taskId = c.req.param("taskId");
    const db = c.get("db");

    const result = await db.query<{ id: string; testing_config_json: string | null }>(
      `SELECT id, testing_config_json FROM tasks WHERE id = $1 LIMIT 1`,
      [taskId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new PragmaError("TASK_NOT_FOUND", 404, `Task not found: ${taskId}`);
    }

    let config: unknown = null;
    if (row.testing_config_json) {
      try {
        config = JSON.parse(row.testing_config_json);
      } catch {
        config = null;
      }
    }

    return c.json({ config });
  });

  app.post("/tasks/:taskId/testing/start", async (c) => {
    const workspaceName = c.get("workspace");
    const taskId = c.req.param("taskId");
    const db = c.get("db");

    const result = await db.query<{ id: string; testing_config_json: string | null }>(
      `SELECT id, testing_config_json FROM tasks WHERE id = $1 LIMIT 1`,
      [taskId],
    );
    const row = result.rows[0];
    if (!row) {
      throw new PragmaError("TASK_NOT_FOUND", 404, `Task not found: ${taskId}`);
    }
    if (!row.testing_config_json) {
      throw new PragmaError("NO_TESTING_CONFIG", 400, "No testing config found for this task.");
    }

    let config: {
      setup?: string[];
      processes: Array<{
        name: string;
        command: string;
        cwd?: string;
        port?: number;
        healthcheck?: string;
        ready_pattern?: string;
      }>;
    };
    try {
      config = JSON.parse(row.testing_config_json);
    } catch {
      throw new PragmaError("INVALID_TESTING_CONFIG", 400, "Testing config JSON is invalid.");
    }

    const workspacePaths = getWorkspacePaths(workspaceName);
    const runRoot = await resolveTaskExecutionRoot(workspacePaths, taskId);

    if (config.setup && config.setup.length > 0) {
      for (const setupCmd of config.setup) {
        const setupResult = await runShellCommandDetailed({
          command: setupCmd,
          cwd: runRoot,
          env: {
            ...process.env,
            PRAGMA_WORKSPACE_NAME: workspaceName,
            PRAGMA_TASK_ID: taskId,
          },
        });
        if (setupResult.exitCode !== 0) {
          throw new PragmaError(
            "TESTING_SETUP_FAILED",
            500,
            `Setup command failed: ${setupCmd}\n${setupResult.stderr || setupResult.stdout}`,
          );
        }
      }
    }

    const services: Record<string, RuntimeServiceSummary> = {};
    for (const proc of config.processes) {
      const processCwd = proc.cwd
        ? await resolveTaskCommandCwd(runRoot, proc.cwd)
        : runRoot;

      const port = await getRandomFreePort();

      const env = {
        ...process.env,
        PORT: String(port),
        PRAGMA_WORKSPACE_NAME: workspaceName,
        PRAGMA_TASK_ID: taskId,
      };

      // Rewrite command for frameworks that don't read PORT
      let command = proc.command;
      if (/\bvite\b|webpack-dev-server/.test(command)) {
        command += ` --port ${port}`;
      }
      if (/\bvite\b|\bnext\b/.test(command)) {
        command += ` --host 127.0.0.1`;
      }

      const service = startRuntimeService({
        workspaceName,
        taskId,
        label: proc.name,
        command,
        requestedCwd: proc.cwd || ".",
        absoluteCwd: processCwd,
        env,
        readyPattern: proc.ready_pattern,
        port,
        healthcheck: proc.healthcheck,
      });

      // Track task-level processes in the processes table
      const taskProcessId = `proc_${randomUUID().slice(0, 12)}`;
      service.process_db_id = taskProcessId;
      void db.query(
        `INSERT INTO processes (id, workspace, folder_name, label, command, cwd, type, status, pid, task_id, started_at)
         VALUES ($1, $2, $3, $4, $5, $6, 'service', 'running', $7, $8, CURRENT_TIMESTAMP)`,
        [taskProcessId, workspaceName, "", proc.name, command, proc.cwd || ".", service.pid, taskId],
      );

      services[proc.name] = toRuntimeServiceSummary(service);
    }

    return c.json({ ok: true, services });
  });

  app.post("/tasks/:taskId/testing/stop", async (c) => {
    const workspaceName = c.get("workspace");
    const taskId = c.req.param("taskId");
    const db = c.get("db");

    const store = getWorkspaceServiceStore(workspaceName);
    for (const service of store.values()) {
      if (service.task_id === taskId) {
        stopRuntimeService(service);
      }
    }

    // Update task processes in DB
    void db.query(
      `UPDATE processes SET status = 'stopped', stopped_at = CURRENT_TIMESTAMP WHERE task_id = $1 AND status = 'running'`,
      [taskId],
    );

    return c.json({ ok: true });
  });

  app.post(
    "/tasks/:taskId/testing/proxy",
    validateJson(testingProxyRequestSchema),
    async (c) => {
      const workspaceName = c.get("workspace");
      const taskId = c.req.param("taskId");
      const body = c.req.valid("json");

      let servicePort: number | null = null;
      const store = getWorkspaceServiceStore(workspaceName);
      for (const service of store.values()) {
        if (service.task_id === taskId && service.label === body.process_name && service.port) {
          servicePort = service.port;
          break;
        }
      }

      if (!servicePort) {
        throw new PragmaError(
          "PROCESS_NOT_FOUND",
          404,
          `Process "${body.process_name}" not found or has no port assigned.`,
        );
      }

      const targetUrl = `http://127.0.0.1:${servicePort}${body.path}`;
      const startTime = Date.now();
      try {
        const fetchResponse = await fetch(targetUrl, {
          method: body.method,
          headers: body.headers as Record<string, string> | undefined,
          body: body.method !== "GET" && body.method !== "HEAD" ? body.body : undefined,
        });
        const elapsed = Date.now() - startTime;
        const responseBody = await fetchResponse.text();
        const responseHeaders: Record<string, string[]> = {};
        fetchResponse.headers.forEach((value, key) => {
          responseHeaders[key] = [value];
        });

        return c.json({
          status: fetchResponse.status,
          headers: responseHeaders,
          body: responseBody,
          elapsed_ms: elapsed,
        });
      } catch (error) {
        throw new PragmaError(
          "PROXY_REQUEST_FAILED",
          502,
          `Proxy request to ${targetUrl} failed: ${errorMessage(error)}`,
        );
      }
    },
  );

  app.post(
    "/services/:serviceId/stdin",
    validateJson(serviceStdinSchema),
    async (c) => {
      const workspaceName = c.get("workspace");
      const serviceId = c.req.param("serviceId");
      const body = c.req.valid("json");

      const service = getRuntimeService(workspaceName, serviceId);
      if (!service) {
        throw new PragmaError("SERVICE_NOT_FOUND", 404, `Service not found: ${serviceId}`);
      }
      if (service.status !== "running" && service.status !== "ready") {
        throw new PragmaError("SERVICE_NOT_RUNNING", 409, `Service is not running: ${serviceId}`);
      }

      const child = service._child;
      if (!child || !child.stdin) {
        throw new PragmaError("SERVICE_NO_STDIN", 400, "Service stdin is not available.");
      }

      child.stdin.write(body.text);
      return c.json({ ok: true });
    },
  );

  app.post("/tasks/:taskId/agent/ask-question", validateJson(agentAskQuestionSchema), async (c) => {
    const workspaceName = c.get("workspace");
    const taskId =c.req.param("taskId");
    const body = c.req.valid("json");

    const db = c.get("db");
    await ensureConversationSchema(db);
    const taskResult = await db.query<{ id: string; status: TaskStatus; assigned_to: string | null }>(
      `
SELECT id, status, assigned_to
FROM tasks
WHERE id = $1
LIMIT 1
`,
      [taskId],
    );
    const task = taskResult.rows[0];
    if (!task) {
      throw new PragmaError("TASK_NOT_FOUND", 404, `Task not found: ${taskId}`);
    }
    if (task.status !== "running" && task.status !== "planning") {
      throw new PragmaError("TASK_NOT_RUNNING", 409, `Task is not running: ${taskId}`);
    }

    const previousStatus = task.status;

    await db.query(
      `
UPDATE tasks
SET status = 'waiting_for_question_response'
WHERE id = $1
`,
      [taskId],
    );
    emitTaskStatus(workspaceName, taskId, "waiting_for_question_response", "worker_ask_question");

    const thread = await getThreadByTaskId(db, taskId);
    if (thread) {
      const latestTurn = thread.mode === "plan"
        ? await getLatestPlanTurn(db, thread.id)
        : await getLatestExecuteTurn(db, thread.id);
      await insertEvent(db, {
        id: `evt_${randomUUID().slice(0, 12)}`,
        threadId: thread.id,
        turnId: body.turn_id || latestTurn?.id || null,
        eventName: "worker_question_requested",
        payload: {
          question: body.question,
          details: body.details ?? null,
          options: body.options ?? null,
          agent_id: body.agent_id ?? task.assigned_to ?? null,
          previous_status: previousStatus,
        },
      });
    }

    return c.json({ ok: true, status: "waiting_for_question_response" });
  });

  app.post("/tasks/:taskId/agent/request-help", validateJson(agentRequestHelpSchema), async (c) => {
    const workspaceName = c.get("workspace");
    const taskId =c.req.param("taskId");
    const body = c.req.valid("json");

    const db = c.get("db");
    await ensureConversationSchema(db);
    const taskResult = await db.query<{ id: string; status: TaskStatus; assigned_to: string | null }>(
      `
SELECT id, status, assigned_to
FROM tasks
WHERE id = $1
LIMIT 1
`,
      [taskId],
    );
    const task = taskResult.rows[0];
    if (!task) {
      throw new PragmaError("TASK_NOT_FOUND", 404, `Task not found: ${taskId}`);
    }
    if (task.status !== "running") {
      throw new PragmaError("TASK_NOT_RUNNING", 409, `Task is not running: ${taskId}`);
    }

    await db.query(
      `
UPDATE tasks
SET status = 'waiting_for_help_response'
WHERE id = $1
`,
      [taskId],
    );
    emitTaskStatus(workspaceName, taskId, "waiting_for_help_response", "worker_request_help");

    const thread = await getThreadByTaskId(db, taskId);
    if (thread) {
      const latestExecuteTurn = await getLatestExecuteTurn(db, thread.id);
      await insertEvent(db, {
        id: `evt_${randomUUID().slice(0, 12)}`,
        threadId: thread.id,
        turnId: body.turn_id || latestExecuteTurn?.id || null,
        eventName: "worker_help_requested",
        payload: {
          summary: body.summary,
          details: body.details ?? null,
          agent_id: body.agent_id ?? task.assigned_to ?? null,
        },
      });
    }

    return c.json({ ok: true, status: "waiting_for_help_response" });
  });

  app.post("/tasks/:taskId/stop", validateJson(stopTaskSchema), async (c) => {
    const workspaceName = c.get("workspace");
    const taskId = c.req.param("taskId");
    const body = c.req.valid("json");

    const db = c.get("db");
    let requeue: {
      threadId: string;
      prompt: string;
      recipientAgentId: string;
      reasoningEffort: ReasoningEffort;
      resumeWorkerSessionId: string | null;
      followUpMessage: string;
    } | null = null;

    await ensureConversationSchema(db);
    const taskResult = await db.query<{
      id: string;
      status: TaskStatus;
      assigned_to: string | null;
    }>(
      `SELECT id, status, assigned_to FROM tasks WHERE id = $1 LIMIT 1`,
      [taskId],
    );
    const task = taskResult.rows[0];
    if (!task) {
      throw new PragmaError("TASK_NOT_FOUND", 404, `Task not found: ${taskId}`);
    }

    const stoppable = task.status === "running" || task.status === "orchestrating" || task.status === "queued";
    if (!stoppable) {
      throw new PragmaError(
        "TASK_NOT_STOPPABLE",
        409,
        `Task is not in a stoppable state (${task.status}): ${taskId}`,
      );
    }

    executeRunner.abort(taskId);

    const thread = await getThreadByTaskId(db, taskId);

    if (body.message && thread) {
      // User sent a redirect message — insert it and requeue
      await insertMessage(db, {
        id: `msg_${randomUUID().slice(0, 12)}`,
        threadId: thread.id,
        turnId: null,
        role: "user",
        content: body.message,
      });

      await insertEvent(db, {
        id: `evt_${randomUUID().slice(0, 12)}`,
        threadId: thread.id,
        turnId: null,
        eventName: "task_stopped",
        payload: { message: body.message, previous_status: task.status },
      });

      await db.query(`UPDATE tasks SET status = 'queued' WHERE id = $1`, [taskId]);
      emitTaskStatus(workspaceName, taskId, "queued", "task_stopped");
      publishThreadUpdated(workspaceName, thread.id, "task_stopped");

      const latestExecuteTurn = await getLatestExecuteTurn(db, thread.id);
      if (latestExecuteTurn && task.assigned_to) {
        requeue = {
          threadId: thread.id,
          prompt: latestExecuteTurn.user_message,
          recipientAgentId: task.assigned_to,
          reasoningEffort: requireReasoningEffort(
            latestExecuteTurn.reasoning_effort,
            `latest execute turn for task ${taskId}`,
          ),
          resumeWorkerSessionId: latestExecuteTurn.worker_session_id ?? null,
          followUpMessage: body.message,
        };
      }
    } else {
      // No message — just stop
      if (thread) {
        await insertEvent(db, {
          id: `evt_${randomUUID().slice(0, 12)}`,
          threadId: thread.id,
          turnId: null,
          eventName: "task_stopped",
          payload: { previous_status: task.status },
        });
        publishThreadUpdated(workspaceName, thread.id, "task_stopped");
      }

      await db.query(
        `UPDATE tasks SET status = 'waiting_for_question_response' WHERE id = $1`,
        [taskId],
      );
      emitTaskStatus(workspaceName, taskId, "waiting_for_question_response", "task_stopped");
    }

    if (requeue) {
      executeRunner.execute({
        workspaceName,
        taskId,
        threadId: requeue.threadId,
        prompt: requeue.prompt,
        requestedRecipientAgentId: requeue.recipientAgentId,
        reasoningEffort: requeue.reasoningEffort,
        resumeWorkerSessionId: requeue.resumeWorkerSessionId,
        followUpMessage: requeue.followUpMessage,
      });
      return c.json({ ok: true, status: "queued" });
    }

    return c.json({ ok: true, status: "waiting_for_question_response" });
  });

  app.post("/tasks/:taskId/respond", validateJson(taskRespondSchema), async (c) => {
    const workspaceName = c.get("workspace");
    const taskId =c.req.param("taskId");
    const body = c.req.valid("json");

    const db = c.get("db");
    let requeue: {
      threadId: string;
      prompt: string;
      recipientAgentId: string;
      reasoningEffort: ReasoningEffort;
      resumeWorkerSessionId: string | null;
      followUpMessage: string;
    } | null = null;

    let planContinuation: {
      threadId: string;
      turnId: string;
      userMessageId: string;
      message: string;
      harness: HarnessId;
      modelLabel: string;
      modelId: string;
      reasoningEffort: ReasoningEffort;
      requestedRecipientAgentId?: string | null;
    } | null = null;

    await ensureConversationSchema(db);
    const taskResult = await db.query<{
      id: string;
      status: TaskStatus;
      assigned_to: string | null;
    }>(
      `
SELECT id, status, assigned_to
FROM tasks
WHERE id = $1
LIMIT 1
`,
      [taskId],
    );
    const task = taskResult.rows[0];
    if (!task) {
      throw new PragmaError("TASK_NOT_FOUND", 404, `Task not found: ${taskId}`);
    }
    if (
      task.status !== "waiting_for_question_response" &&
      task.status !== "waiting_for_help_response" &&
      task.status !== "pending_review" &&
      task.status !== "completed"
    ) {
      throw new PragmaError(
        "TASK_NOT_WAITING_FOR_RESPONSE",
        409,
        `Task is not waiting for a human response: ${taskId}`,
      );
    }

    const thread = await getThreadByTaskId(db, taskId);
    if (!thread) {
      throw new PragmaError("TASK_THREAD_NOT_FOUND", 404, `No conversation thread found for task: ${taskId}`);
    }

    // Plan threads: transition back to planning and start a continuation turn
    if (thread.mode === "plan") {
      const latestPlanTurn = await getLatestPlanTurn(db, thread.id);

      const continuationTurnId = `turn_${randomUUID().slice(0, 12)}`;
      const continuationMsgId = `msg_${randomUUID().slice(0, 12)}`;

      await insertMessage(db, {
        id: `msg_${randomUUID().slice(0, 12)}`,
        threadId: thread.id,
        turnId: null,
        role: "user",
        content: body.message,
      });

      await insertEvent(db, {
        id: `evt_${randomUUID().slice(0, 12)}`,
        threadId: thread.id,
        turnId: null,
        eventName: "human_response_received",
        payload: {
          message: body.message,
          responded_to_status: task.status,
        },
      });

      const reasoningEffort = latestPlanTurn?.reasoning_effort ?? "high";

      await createTurn(db, {
        id: continuationTurnId,
        threadId: thread.id,
        mode: "plan",
        userMessage: body.message,
        reasoningEffort,
        requestedRecipientAgentId: latestPlanTurn?.requested_recipient_agent_id ?? null,
      });

      await insertMessage(db, {
        id: continuationMsgId,
        threadId: thread.id,
        turnId: continuationTurnId,
        role: "user",
        content: body.message,
      });

      await db.query(
        `UPDATE tasks SET status = 'planning' WHERE id = $1`,
        [taskId],
      );
      emitTaskStatus(workspaceName, taskId, "planning", "plan_question_responded");
      publishThreadUpdated(workspaceName, thread.id, "human_response_received");

      planContinuation = {
        threadId: thread.id,
        turnId: continuationTurnId,
        userMessageId: continuationMsgId,
        message: body.message,
        harness: thread.harness,
        modelLabel: thread.model_label,
        modelId: thread.model_id,
        reasoningEffort,
        requestedRecipientAgentId: latestPlanTurn?.requested_recipient_agent_id ?? null,
      };
    } else {
      // Execute threads: requeue via executeRunner
      if (!task.assigned_to) {
        throw new PragmaError(
          "TASK_MISSING_ASSIGNED_WORKER",
          409,
          `Task has no assigned worker to resume: ${taskId}`,
        );
      }
      const resumeWorker = await getAgentById(db, task.assigned_to);
      if (!resumeWorker || resumeWorker.id === DEFAULT_AGENT_ID) {
        throw new PragmaError(
          "TASK_INVALID_ASSIGNED_WORKER",
          409,
          `Assigned worker is invalid for task resume: ${taskId}`,
        );
      }

      const latestExecuteTurn = await getLatestExecuteTurn(db, thread.id);
      if (!latestExecuteTurn || !latestExecuteTurn.user_message.trim()) {
        throw new PragmaError("NO_EXECUTE_PROMPT", 409, "No execute task prompt is available for this task.");
      }

      await insertMessage(db, {
        id: `msg_${randomUUID().slice(0, 12)}`,
        threadId: thread.id,
        turnId: null,
        role: "user",
        content: body.message,
      });

      await insertEvent(db, {
        id: `evt_${randomUUID().slice(0, 12)}`,
        threadId: thread.id,
        turnId: latestExecuteTurn.id,
        eventName: "human_response_received",
        payload: {
          message: body.message,
          responded_to_status: task.status,
        },
      });

      await db.query(
        `
UPDATE tasks
SET status = 'queued'
WHERE id = $1
`,
        [taskId],
      );
      emitTaskStatus(workspaceName, taskId, "queued", "execute_question_responded");
      publishThreadUpdated(workspaceName, thread.id, "human_response_received");

      requeue = {
        threadId: thread.id,
        prompt: latestExecuteTurn.user_message,
        recipientAgentId: resumeWorker.id,
        reasoningEffort: requireReasoningEffort(
          latestExecuteTurn.reasoning_effort,
          `latest execute turn for task ${taskId}`,
        ),
        resumeWorkerSessionId: latestExecuteTurn.worker_session_id ?? null,
        followUpMessage: body.message,
      };
    }

    if (requeue) {
      executeRunner.execute({
        workspaceName,
        taskId,
        threadId: requeue.threadId,
        prompt: requeue.prompt,
        requestedRecipientAgentId: requeue.recipientAgentId,
        reasoningEffort: requeue.reasoningEffort,
        resumeWorkerSessionId: requeue.resumeWorkerSessionId,
        followUpMessage: requeue.followUpMessage,
      });
    }

    if (planContinuation) {
      turnRunner.execute({
        workspaceName,
        threadId: planContinuation.threadId,
        turnId: planContinuation.turnId,
        userMessageId: planContinuation.userMessageId,
        isNewThread: false,
        message: planContinuation.message,
        mode: "plan",
        harness: planContinuation.harness,
        modelLabel: planContinuation.modelLabel,
        modelId: planContinuation.modelId,
        reasoningEffort: planContinuation.reasoningEffort,
        requestedRecipientAgentId: planContinuation.requestedRecipientAgentId,
      });
    }

    return c.json({ ok: true, status: requeue ? "queued" : "planning" });
  });

  app.post(
    "/conversations/:threadId/turns/:turnId/agent/select-recipient",
    validateJson(planSelectRecipientSchema),
    async (c) => {
    const workspaceName = c.get("workspace");
    const threadId = c.req.param("threadId");
    const turnId = c.req.param("turnId");
    const body = c.req.valid("json");

    const db = c.get("db");
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
      throw new PragmaError(
        "TURN_NOT_FOUND",
        404,
        `Conversation turn not found: ${turnId}`,
      );
    }
    if (turn.mode !== "plan") {
      throw new PragmaError(
        "TURN_NOT_PLAN_MODE",
        409,
        `Turn is not in plan mode: ${turnId}`,
      );
    }

    const selectedAgentId = body.agent_id;
    const recipient = await getAgentById(db, selectedAgentId);
    if (!recipient || recipient.id === DEFAULT_AGENT_ID) {
      const candidates = await listPlanWorkerCandidates(db, DEFAULT_AGENT_ID);
      const validAgentIds = candidates.map((candidate) => candidate.id);
      const validSuffix =
        validAgentIds.length > 0
          ? ` Valid worker ids: ${validAgentIds.join(", ")}.`
          : " No worker agents are currently available.";
      return c.json(
        {
          error: "INVALID_RECIPIENT",
          message: `Invalid recipient agent id: ${selectedAgentId}.${validSuffix}`,
          valid_agent_ids: validAgentIds,
          valid_agents: candidates,
        },
        400,
      );
    }

    await db.query(
      `
UPDATE conversation_turns
SET selected_agent_id = $2,
    selection_status = 'auto_selected'
WHERE id = $1
`,
      [turnId, selectedAgentId],
    );

    await insertEvent(db, {
      id: `evt_${randomUUID().slice(0, 12)}`,
      threadId,
      turnId,
      eventName: "plan_recipient_selected",
      payload: {
        source: "cli",
        selected_agent_id: selectedAgentId,
        reason: body.reason,
      },
    });

    return c.json({ ok: true, selected_agent_id: selectedAgentId });
  });

  // Plan proposal: agent submits a structured list of tasks
  app.post(
    "/conversations/:threadId/turns/:turnId/agent/plan-propose",
    validateJson(planProposeSchema),
    async (c) => {
    const workspaceName = c.get("workspace");
    const threadId = c.req.param("threadId");
    const turnId = c.req.param("turnId");
    const body = c.req.valid("json");

    const db = c.get("db");
    await ensureConversationSchema(db);

    const turnResult = await db.query<{
      id: string;
      thread_id: string;
      mode: "chat" | "plan" | "execute";
    }>(
      `SELECT id, thread_id, mode FROM conversation_turns WHERE id = $1 AND thread_id = $2 LIMIT 1`,
      [turnId, threadId],
    );

    const turn = turnResult.rows[0];
    if (!turn) {
      throw new PragmaError("TURN_NOT_FOUND", 404, `Conversation turn not found: ${turnId}`);
    }
    if (turn.mode !== "plan") {
      throw new PragmaError("TURN_NOT_PLAN_MODE", 409, `Turn is not in plan mode: ${turnId}`);
    }

    // Validate all recipient agent ids
    for (const task of body.tasks) {
      const recipient = await getAgentById(db, task.recipient);
      if (!recipient || recipient.id === DEFAULT_AGENT_ID) {
        const candidates = await listPlanWorkerCandidates(db, DEFAULT_AGENT_ID);
        const validAgentIds = candidates.map((c) => c.id);
        return c.json(
          {
            error: "INVALID_RECIPIENT",
            message: `Invalid recipient agent id: ${task.recipient}. Valid worker ids: ${validAgentIds.join(", ")}.`,
            valid_agent_ids: validAgentIds,
          },
          400,
        );
      }
    }

    // Store proposal on the turn
    await storePlanProposal(db, turnId, { tasks: body.tasks });

    // Also set selected_agent_id to the first task's recipient for backwards compatibility
    await db.query(
      `UPDATE conversation_turns SET selected_agent_id = $2, selection_status = 'auto_selected' WHERE id = $1`,
      [turnId, body.tasks[0].recipient],
    );

    // Emit event
    await insertEvent(db, {
      id: `evt_${randomUUID().slice(0, 12)}`,
      threadId,
      turnId,
      eventName: "plan_proposal_submitted",
      payload: {
        source: "cli",
        tasks: body.tasks,
      },
    });

    publishThreadUpdated(workspaceName, threadId, "plan_proposal_submitted");

    return c.json({ ok: true, task_count: body.tasks.length });
  });

  // Read the plan proposal for a thread
  app.get("/conversations/:threadId/plan-proposal", async (c) => {
    const workspaceName = c.get("workspace");
    const threadId = c.req.param("threadId");
    const db = c.get("db");

    await ensureConversationSchema(db);
    const proposal = await getPlanProposal(db, threadId);
    return c.json({ proposal });
  });

  // Execute a plan proposal as a chain of tasks
  app.post(
    "/conversations/:threadId/execute-proposal",
    validateJson(executePlanProposalSchema),
    async (c) => {
    const workspaceName = c.get("workspace");
    const threadId = c.req.param("threadId");
    const body = c.req.valid("json");
    const reasoningEffort = body.reasoning_effort;

    const db = c.get("db");
    const taskIds: string[] = [];

    await ensureConversationSchema(db);

    const thread = await getThreadById(db, threadId);
    if (!thread) {
      throw new PragmaError("THREAD_NOT_FOUND", 404, `Conversation thread not found: ${threadId}`);
    }

    const latestPlanTurn = await getLatestCompletedPlanTurn(db, threadId);
    const planText = latestPlanTurn?.assistant_message?.trim() || null;

    // Validate all recipients
    for (const task of body.tasks) {
      const recipient = await getAgentById(db, task.recipient_agent_id);
      if (!recipient || recipient.id === DEFAULT_AGENT_ID) {
        throw new PragmaError("INVALID_RECIPIENT", 400, `Invalid recipient agent id: ${task.recipient_agent_id}`);
      }
    }

    // Create tasks as a chain
    let previousTaskId: string | null = thread.task_id || null;
    let firstTaskId = "";

    for (let i = 0; i < body.tasks.length; i++) {
      const taskSpec = body.tasks[i];
      const recipient = await getAgentById(db, taskSpec.recipient_agent_id);
      if (!recipient) continue;

      const newTaskId = `task_${randomUUID().slice(0, 8)}`;
      const taskTitle = taskSpec.title.length > 80 ? `${taskSpec.title.slice(0, 77)}...` : taskSpec.title;

      if (i === 0 && previousTaskId) {
        // First task: update the existing plan task
        await db.query(
          `UPDATE tasks SET status = 'running', assigned_to = $2, plan = $3, title = $4 WHERE id = $1`,
          [previousTaskId, recipient.id, taskSpec.prompt, taskTitle],
        );
        emitTaskStatus(workspaceName, previousTaskId, "running", "execute_proposal");
        firstTaskId = previousTaskId;
        taskIds.push(previousTaskId);

        // Create execute thread for first task
        const execThreadId = `thread_${randomUUID().slice(0, 12)}`;
        await createThread(db, {
          id: execThreadId,
          mode: "execute",
          harness: recipient.harness,
          modelLabel: recipient.model_label,
          modelId: recipient.model_id,
          sourceThreadId: threadId,
          taskId: previousTaskId,
        });
        await setThreadTaskId(db, execThreadId, previousTaskId);

        executeRunner.execute({
          workspaceName,
          taskId: previousTaskId,
          threadId: execThreadId,
          prompt: taskSpec.prompt,
          requestedRecipientAgentId: recipient.id,
          reasoningEffort,
          skipOrchestratorSelection: true,
        });
      } else if (i === 0) {
        // First task: create new task
        await db.query(
          `INSERT INTO tasks (id, title, status, assigned_to, output_dir, session_id, plan) VALUES ($1, $2, 'queued', $3, NULL, NULL, $4)`,
          [newTaskId, taskTitle, recipient.id, taskSpec.prompt],
        );
        emitTaskStatus(workspaceName, newTaskId, "queued", "execute_proposal_created");
        firstTaskId = newTaskId;
        taskIds.push(newTaskId);

        const execThreadId = `thread_${randomUUID().slice(0, 12)}`;
        await createThread(db, {
          id: execThreadId,
          mode: "execute",
          harness: recipient.harness,
          modelLabel: recipient.model_label,
          modelId: recipient.model_id,
          sourceThreadId: threadId,
          taskId: newTaskId,
        });
        await setThreadTaskId(db, execThreadId, newTaskId);

        executeRunner.execute({
          workspaceName,
          taskId: newTaskId,
          threadId: execThreadId,
          prompt: taskSpec.prompt,
          requestedRecipientAgentId: recipient.id,
          reasoningEffort,
          skipOrchestratorSelection: true,
        });
        previousTaskId = newTaskId;
      } else {
        // Subsequent tasks: create as followups
        await db.query(
          `INSERT INTO tasks (id, title, status, assigned_to, output_dir, session_id, plan, predecessor_task_id) VALUES ($1, $2, 'queued', $3, NULL, NULL, $4, $5)`,
          [newTaskId, taskTitle, recipient.id, taskSpec.prompt, previousTaskId],
        );
        await db.query(
          `UPDATE tasks SET followup_task_id = $2 WHERE id = $1`,
          [previousTaskId!, newTaskId],
        );

        const execThreadId = `thread_${randomUUID().slice(0, 12)}`;
        await createThread(db, {
          id: execThreadId,
          mode: "execute",
          harness: recipient.harness,
          modelLabel: recipient.model_label,
          modelId: recipient.model_id,
          sourceThreadId: threadId,
          taskId: newTaskId,
        });
        await setThreadTaskId(db, execThreadId, newTaskId);

        emitTaskStatus(workspaceName, newTaskId, "queued", "proposal_followup_created");
        taskIds.push(newTaskId);
        previousTaskId = newTaskId;
      }
    }

    // Close the plan thread
    await closeThread(db, threadId);

    return c.json({ task_ids: taskIds }, 201);
  });

  app.get("/conversations/chats", validateQuery(chatsQuerySchema), async (c) => {
    const workspaceName = c.get("workspace");
    const { limit, cursor } = c.req.valid("query");
    const db = c.get("db");

    await ensureConversationSchema(db);
    const chats = await listChatThreads(db, { limit, cursor });
    return c.json({ chats });
  });

  app.get("/conversations/plans", validateQuery(plansQuerySchema), async (c) => {
    const workspaceName = c.get("workspace");
    const { limit, cursor } = c.req.valid("query");
    const db = c.get("db");

    await ensureConversationSchema(db);
    const pendingPlans = await listOpenPlanThreads(db, { limit, cursor });
    const plans = pendingPlans.map((plan) => {
      const metadata = derivePendingPlanMetadata(plan.first_user_message);
      return {
        id: plan.id,
        plan_title: metadata.title,
        plan_preview: metadata.preview,
        status: plan.status,
        created_at: plan.created_at,
        updated_at: plan.updated_at,
        has_completed_plan_turn: Boolean(plan.has_completed_plan_turn),
        latest_turn_status: plan.latest_turn_status ?? null,
        task_id: plan.task_id ?? null,
        task_status: plan.task_status ?? null,
      };
    });
    return c.json({ plans });
  });

  app.get("/conversations/:threadId", async (c) => {
    const workspaceName = c.get("workspace");
    const threadId = c.req.param("threadId");
    const db = c.get("db");

    await ensureConversationSchema(db);
    const data = await getThreadWithDetails(db, threadId);
    if (!data.thread) {
      throw new PragmaError("THREAD_NOT_FOUND", 404, `Conversation thread not found: ${threadId}`);
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
  });

  app.delete("/conversations/:threadId", async (c) => {
    const workspaceName = c.get("workspace");
    const threadId = c.req.param("threadId");
    const db = c.get("db");

    await ensureConversationSchema(db);
    const thread = await getThreadById(db, threadId);
    if (!thread) {
      throw new PragmaError("THREAD_NOT_FOUND", 404, `Conversation thread not found: ${threadId}`);
    }
    if (thread.mode !== "plan") {
      throw new PragmaError("INVALID_OPERATION", 400, "Only plan threads can be deleted.");
    }
    await closeThread(db, threadId);

    // If the thread is associated with a task, cancel the task too
    if (thread.task_id) {
      const taskResult = await db.query<{ id: string; status: string }>(
        `SELECT id, status FROM tasks WHERE id = $1 LIMIT 1`,
        [thread.task_id],
      );
      const task = taskResult.rows[0];
      if (task && task.status !== "cancelled" && task.status !== "completed" && task.status !== "failed") {
        await db.query(
          `UPDATE tasks SET status = 'cancelled', completed_at = CURRENT_TIMESTAMP WHERE id = $1`,
          [thread.task_id],
        );
        emitTaskStatus(workspaceName, thread.task_id, "cancelled", "plan_deleted");

        executeRunner.abort(thread.task_id);
        const workspacePaths = getWorkspacePaths(workspaceName);
        await deleteTaskWorktree({ workspacePaths, taskId: thread.task_id });
      }
    }

    return c.json({ ok: true });
  });

  // Fire-and-forget turn creation. No SSE — the UI subscribes via
  // GET /conversations/:threadId/stream to watch events.
  app.post("/conversations/turns", validateJson(conversationTurnSchema), async (c) => {
    const workspaceName = c.get("workspace");
    const body = c.req.valid("json");
    const modelId = resolveModelId(body.harness, body.model_label);
    const reasoningEffort = body.reasoning_effort;
    const db = c.get("db");
    await ensureConversationSchema(db);
    const requestedRecipientAgentId =
      body.mode === "plan" ? (body.recipient_agent_id ?? null) : null;
    if (requestedRecipientAgentId) {
      const recipient = await getAgentById(db, requestedRecipientAgentId);
      if (!recipient || recipient.id === DEFAULT_AGENT_ID) {
        throw new PragmaError(
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
      throw new PragmaError("THREAD_CREATE_FAILED", 400, "Could not create conversation thread.");
    }

    // Create a task row when a plan thread starts so ask-question works
    if (body.mode === "plan" && isNewThread) {
      const planTaskId = `task_${randomUUID().slice(0, 8)}`;
      const planTitle = truncateChatText(
        body.message.replace(/\s+/g, " ").trim() || "Plan",
        80,
      );
      await db.query(
        `
INSERT INTO tasks (id, title, status, assigned_to, output_dir, session_id)
VALUES ($1, $2, 'planning', NULL, NULL, NULL)
`,
        [planTaskId, planTitle],
      );
      emitTaskStatus(workspaceName, planTaskId, "planning", "plan_created");

      // Fire-and-forget: generate an AI title from the prompt
      generateTitle(db, body.message, "").then(async (aiTitle) => {
        await updateTaskTitle(db, planTaskId, aiTitle);
        const row = await db.query<{ status: TaskStatus }>(
          `SELECT status FROM tasks WHERE id = $1 LIMIT 1`,
          [planTaskId],
        );
        const currentStatus = row.rows[0]?.status;
        if (currentStatus) {
          emitTaskStatus(workspaceName, planTaskId, currentStatus, "title_generated");
        }
      }).catch(() => {});

      await setThreadTaskId(db, threadId, planTaskId);
      thread = await getThreadById(db, threadId);
    }

    if (!thread) {
      throw new PragmaError("THREAD_CREATE_FAILED", 400, "Could not create conversation thread.");
    }

    if (thread.harness !== body.harness) {
      throw new PragmaError(
        "THREAD_HARNESS_MISMATCH",
        409,
        "Thread harness does not match the requested harness.",
      );
    }

    if (thread.status === "closed") {
      if (thread.mode === "execute" || thread.mode === "plan") {
        await reopenThread(db, thread.id);
        thread = await getThreadById(db, thread.id);
      } else {
        throw new PragmaError("THREAD_CLOSED", 409, "Conversation thread is already closed.");
      }
    }

    if (!thread) {
      throw new PragmaError("THREAD_NOT_FOUND", 404, `Conversation thread not found: ${threadId}`);
    }

    const turnId = `turn_${randomUUID().slice(0, 12)}`;
    const userMessageId = `msg_${randomUUID().slice(0, 12)}`;
    const message = body.message;

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

    // Kick off the turn in the background — no blocking, no SSE.
    turnRunner.execute({
      workspaceName,
      threadId,
      turnId,
      userMessageId,
      isNewThread,
      message,
      mode: body.mode,
      harness: body.harness,
      modelLabel: body.model_label,
      modelId,
      reasoningEffort,
      requestedRecipientAgentId,
    });

    return c.json({ turn_id: turnId, thread_id: threadId, task_id: thread.task_id ?? null });
  });

  // Backwards-compat: keep the old streaming endpoint alive but redirect
  // to the new fire-and-forget endpoint. Clients should migrate to
  // POST /conversations/turns + GET /conversations/:threadId/stream.
  app.post("/conversations/turns/stream", validateJson(conversationTurnSchema), async (c) => {
    const workspaceName = c.get("workspace");
    const body = c.req.valid("json");
    const modelId = resolveModelId(body.harness, body.model_label);
    const reasoningEffort = body.reasoning_effort;
    const db = c.get("db");
    await ensureConversationSchema(db);
    try {
      const requestedRecipientAgentId =
        body.mode === "plan" ? (body.recipient_agent_id ?? null) : null;
      if (requestedRecipientAgentId) {
        const recipient = await getAgentById(db, requestedRecipientAgentId);
        if (!recipient || recipient.id === DEFAULT_AGENT_ID) {
          throw new PragmaError(
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
        throw new PragmaError("THREAD_CREATE_FAILED", 400, "Could not create conversation thread.");
      }

      if (body.mode === "plan" && isNewThread) {
        const planTaskId = `task_${randomUUID().slice(0, 8)}`;
        const planTitle = truncateChatText(
          body.message.replace(/\s+/g, " ").trim() || "Plan",
          80,
        );
        await db.query(
          `
INSERT INTO tasks (id, title, status, assigned_to, output_dir, session_id)
VALUES ($1, $2, 'planning', NULL, NULL, NULL)
`,
          [planTaskId, planTitle],
        );
        emitTaskStatus(workspaceName, planTaskId, "planning", "plan_created");

        // Fire-and-forget: generate an AI title from the prompt
        generateTitle(db, body.message, "").then(async (aiTitle) => {
          await updateTaskTitle(db, planTaskId, aiTitle);
          const row = await db.query<{ status: TaskStatus }>(
            `SELECT status FROM tasks WHERE id = $1 LIMIT 1`,
            [planTaskId],
          );
          const currentStatus = row.rows[0]?.status;
          if (currentStatus) {
            emitTaskStatus(workspaceName, planTaskId, currentStatus, "title_generated");
          }
        }).catch(() => {});

        await setThreadTaskId(db, threadId, planTaskId);
        thread = await getThreadById(db, threadId);
      }

      if (!thread) {
        throw new PragmaError("THREAD_CREATE_FAILED", 400, "Could not create conversation thread.");
      }

      if (thread.harness !== body.harness) {
        throw new PragmaError(
          "THREAD_HARNESS_MISMATCH",
          409,
          "Thread harness does not match the requested harness.",
        );
      }

      if (thread.status === "closed") {
        if (thread.mode === "execute" || thread.mode === "plan") {
          await reopenThread(db, thread.id);
          thread = await getThreadById(db, thread.id);
        } else {
          throw new PragmaError("THREAD_CLOSED", 409, "Conversation thread is already closed.");
        }
      }

      if (!thread) {
        throw new PragmaError("THREAD_NOT_FOUND", 404, `Conversation thread not found: ${threadId}`);
      }

      const turnId = `turn_${randomUUID().slice(0, 12)}`;
      const userMessageId = `msg_${randomUUID().slice(0, 12)}`;
      const message = body.message;

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

      // For chat mode: generate a title immediately from the user message,
      // before the assistant responds, so the UI shows a title right away.
      if (body.mode === "chat") {
        const hasTitle = thread.chat_title && thread.chat_title !== "";
        if (!hasTitle) {
          const placeholder = deriveChatTitle(message, "");
          await updateChatThreadMetadata(db, {
            threadId,
            title: placeholder,
            lastMessageAt: new Date().toISOString(),
          });

          // Fire-and-forget: replace placeholder with AI-generated title
          generateTitle(db, message, "").then((aiTitle) => {
            updateChatThreadMetadata(db, {
              threadId,
              title: aiTitle,
              lastMessageAt: new Date().toISOString(),
              force: true,
            }).catch(() => {});
          }).catch(() => {});
        }
      }

      // Capture the current max event seq BEFORE the turn starts so we only
      // stream events produced by this turn, not events from prior turns.
      const seqBeforeTurn = await getMaxEventSeq(db, threadId);

      // Kick off the turn in the background
      turnRunner.execute({
        workspaceName,
        threadId,
        turnId,
        userMessageId,
        isNewThread,
        message,
        mode: body.mode,
        harness: body.harness,
        modelLabel: body.model_label,
        modelId,
        reasoningEffort,
        requestedRecipientAgentId,
      });

      // Stream events from DB to the client until the turn completes or fails
      let lastSeq = seqBeforeTurn;
      let done = false;

      const drainEvents = async (writeEvent: WriteEventFn): Promise<boolean> => {
        const eventDb = await openDatabase(workspaceName);
        try {
          await ensureConversationSchema(eventDb);
          const events = await getEventsSince(eventDb, threadId, lastSeq);
          for (const evt of events) {
            lastSeq = evt.seq;
            const payload = JSON.parse(evt.payload_json);
            await writeEvent(evt.event_name, payload, evt.seq);
            if (evt.event_name === "turn_completed" || evt.event_name === "error" || evt.event_name === "turn_failed") {
              return true;
            }
          }
        } finally {
          await eventDb.close();
        }
        return false;
      };

      return createSSEStream(c, {
        setup: async (writeEvent) => {
          // Replay any events already written
          if (await drainEvents(writeEvent)) {
            done = true;
            return () => {};
          }

          // Subscribe to live updates
          return subscribeThreadUpdates(workspaceName, threadId, () => {
            void drainEvents(writeEvent).then((finished) => {
              if (finished) done = true;
            });
          });
        },
        closedSignal: () => done,
      });
    } catch (error) {
      throw error;
    }
  });

  // Abort an in-progress turn
  app.post("/conversations/turns/:turnId/abort", async (c) => {
    const turnId = c.req.param("turnId");
    const aborted = turnRunner.abort(turnId);
    if (aborted) {
      return c.json({ ok: true, turn_id: turnId, aborted: true });
    }
    return c.json({ ok: true, turn_id: turnId, aborted: false, message: "Turn not found or already completed." });
  });

  app.post("/conversations/:threadId/execute", validateJson(executeFromThreadSchema), async (c) => {
    const workspaceName = c.get("workspace");
    const threadId = c.req.param("threadId");
    const body = c.req.valid("json");
    const reasoningEffort = body.reasoning_effort;
    const db = c.get("db");
    let taskId = "";
    let executeThreadId = `thread_${randomUUID().slice(0, 12)}`;
    let executePrompt = "";
    let requestedRecipientAgentId: string | null = null;

    await ensureConversationSchema(db);

    const thread = await getThreadById(db, threadId);
    if (!thread) {
      throw new PragmaError("THREAD_NOT_FOUND", 404, `Conversation thread not found: ${threadId}`);
    }

    const latestPlanTurn = await getLatestCompletedPlanTurn(db, threadId);
    if (!latestPlanTurn) {
      throw new PragmaError("NO_PLAN_FOUND", 409, "No completed plan turn found.");
    }

    const planText = latestPlanTurn.assistant_message?.trim() || null;
    if (!planText) {
      throw new PragmaError("PLAN_EMPTY", 409, "Plan turn has no assistant message.");
    }
    const plannedRecipientAgentId =
      typeof latestPlanTurn.selected_agent_id === "string" &&
      latestPlanTurn.selected_agent_id.trim().length > 0
        ? latestPlanTurn.selected_agent_id.trim()
        : null;
    requestedRecipientAgentId = body.recipient_agent_id ?? plannedRecipientAgentId;
    if (!requestedRecipientAgentId) {
      throw new PragmaError(
        "PLAN_RECIPIENT_MISSING",
        409,
        "Plan is missing a selected recipient. Submit `pragma-so task plan-select-recipient` in plan mode.",
      );
    }
    const executeRecipient = await getAgentById(db, requestedRecipientAgentId);
    if (!executeRecipient || executeRecipient.id === DEFAULT_AGENT_ID) {
      throw new PragmaError(
        "INVALID_RECIPIENT",
        400,
        `Invalid recipient agent id: ${requestedRecipientAgentId}`,
      );
    }

    executePrompt = planText;

    // Use existing task from the plan thread if available, otherwise create a new one
    if (thread.task_id) {
      taskId = thread.task_id;
      await db.query(
        `
UPDATE tasks
SET status = 'running',
    assigned_to = $2,
    plan = $3
WHERE id = $1
`,
        [taskId, executeRecipient.id, planText],
      );
      emitTaskStatus(workspaceName, taskId, "running", "execute_from_plan");
    } else {
      taskId = `task_${randomUUID().slice(0, 8)}`;
      await db.query(
        `
INSERT INTO tasks (id, title, status, assigned_to, output_dir, session_id, plan)
VALUES ($1, $2, 'queued', $3, NULL, NULL, $4)
`,
        [taskId, truncateChatText(latestPlanTurn.user_message?.replace(/\s+/g, " ").trim() || "Task", 80), executeRecipient.id, planText],
      );
      emitTaskStatus(workspaceName, taskId, "queued", "execute_from_plan_created");
    }

    await createThread(db, {
      id: executeThreadId,
      mode: "execute",
      harness: executeRecipient.harness,
      modelLabel: executeRecipient.model_label,
      modelId: executeRecipient.model_id,
      sourceThreadId: threadId,
      taskId,
    });

    await setThreadTaskId(db, executeThreadId, taskId);
    await closeThread(db, threadId);

    executeRunner.execute({
      workspaceName,
      taskId,
      threadId: executeThreadId,
      prompt: executePrompt,
      requestedRecipientAgentId,
      reasoningEffort,
      skipOrchestratorSelection: true,
    });

    return c.json({ task_id: taskId }, 201);
  });

  app.get("/code/folders", async (c) => {
    const workspaceName = c.get("workspace");
    const paths = getWorkspacePaths(workspaceName);
    const folders = await listCodeFolders(paths.codeDir);
    return c.json({ folders });
  });

  app.post("/code/repos/clone", validateJson(createCodeRepoCloneSchema), async (c) => {
    const workspaceName = c.get("workspace");
    const paths = getWorkspacePaths(workspaceName);
    const body = c.req.valid("json");

    const folderName = normalizeCodeFolderName(deriveCodeFolderNameFromGitUrl(body.git_url));
    const targetPath = join(paths.codeDir, folderName);
    if (await pathExists(targetPath)) {
      throw new PragmaError(
        "CODE_FOLDER_EXISTS",
        409,
        `Code folder already exists: ${folderName}`,
      );
    }

    try {
      await runCommand({
        command: "git",
        args: ["clone", body.git_url, folderName],
        cwd: paths.codeDir,
        env: process.env,
      });
    } catch (error: unknown) {
      throw new PragmaError("CLONE_CODE_REPO_FAILED", 400, errorMessage(error));
    }

    const folders = await listCodeFolders(paths.codeDir);

    // Trigger process detection in the background
    const db = c.get("db");
    void detectProcessCommands(workspaceName, folderName, paths, db);

    return c.json({ ok: true, folder: { name: folderName }, folders }, 201);
  });

  app.post("/code/folders/pick-local", async (c) => {
    if (process.platform !== "darwin") {
      throw new PragmaError(
        "FOLDER_PICKER_UNSUPPORTED",
        400,
        "Folder picker is currently supported on macOS only. Paste a local path manually.",
      );
    }

    try {
      const raw = await runCommand({
        command: "osascript",
        args: [
          "-e",
          'POSIX path of (choose folder with prompt "Select a local folder to copy into code/")',
        ],
        cwd: process.cwd(),
        env: process.env,
      });
      return c.json({
        ok: true,
        cancelled: false,
        path: normalizePickedLocalPath(raw),
      });
    } catch (error: unknown) {
      const message = errorMessage(error);
      if (/user canceled/i.test(message)) {
        return c.json({ ok: true, cancelled: true, path: "" });
      }
      throw new PragmaError("PICK_LOCAL_CODE_FOLDER_FAILED", 400, message);
    }
  });

  app.post("/code/folders/copy-local", validateJson(createCodeFolderCopySchema), async (c) => {
    const workspaceName = c.get("workspace");
    const paths = getWorkspacePaths(workspaceName);
    const body = c.req.valid("json");

    if (body.local_path.includes("\0")) {
      throw new PragmaError("INVALID_LOCAL_CODE_PATH", 400, "Local path is invalid.");
    }

    const sourcePath = resolve(body.local_path.trim());
    const sourceInfo = await stat(sourcePath).catch(() => null);
    if (!sourceInfo?.isDirectory()) {
      throw new PragmaError("LOCAL_CODE_PATH_NOT_FOUND", 404, "Local folder was not found.");
    }

    const folderName = normalizeCodeFolderName(basename(sourcePath));
    const targetPath = join(paths.codeDir, folderName);
    if (await pathExists(targetPath)) {
      throw new PragmaError(
        "CODE_FOLDER_EXISTS",
        409,
        `Code folder already exists: ${folderName}`,
      );
    }

    try {
      await cp(sourcePath, targetPath, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
      });
    } catch (error: unknown) {
      await rm(targetPath, { recursive: true, force: true });
      throw new PragmaError("COPY_LOCAL_CODE_FAILED", 400, errorMessage(error));
    }

    const folders = await listCodeFolders(paths.codeDir);

    // Trigger process detection in the background
    const db = c.get("db");
    void detectProcessCommands(workspaceName, folderName, paths, db);

    return c.json({ ok: true, folder: { name: folderName }, folders }, 201);
  });

  app.post("/code/folders/import", async (c) => {
    const workspaceName = c.get("workspace");
    const paths = getWorkspacePaths(workspaceName);

    let formData: Awaited<ReturnType<typeof c.req.formData>>;
    try {
      formData = await c.req.formData();
    } catch (error: unknown) {
      throw new PragmaError("INVALID_CODE_IMPORT", 400, errorMessage(error));
    }

    const fileEntries = formData.getAll("files");
    const pathEntries = formData.getAll("paths");
    if (fileEntries.length === 0) {
      throw new PragmaError("INVALID_CODE_IMPORT", 400, "No files were selected.");
    }
    if (fileEntries.length !== pathEntries.length) {
      throw new PragmaError("INVALID_CODE_IMPORT", 400, "Import payload is inconsistent.");
    }

    const normalizedPaths = pathEntries.map((entry) => {
      if (typeof entry !== "string") {
        throw new PragmaError("INVALID_CODE_IMPORT", 400, "Import path metadata is invalid.");
      }
      return normalizeImportedPath(entry);
    });
    const inferredRoot = normalizedPaths[0].split("/")[0] || "imported";
    const rootNameEntry = formData.get("root_name");
    const requestedRootName = typeof rootNameEntry === "string" ? rootNameEntry : inferredRoot;
    const folderName = normalizeCodeFolderName(requestedRootName);
    const targetRoot = join(paths.codeDir, folderName);
    if (await pathExists(targetRoot)) {
      throw new PragmaError(
        "CODE_FOLDER_EXISTS",
        409,
        `Code folder already exists: ${folderName}`,
      );
    }

    await mkdir(targetRoot, { recursive: false });

    let copiedFileCount = 0;
    try {
      for (let index = 0; index < fileEntries.length; index += 1) {
        const fileEntry = fileEntries[index];
        if (!isUploadedFile(fileEntry)) {
          throw new PragmaError("INVALID_CODE_IMPORT", 400, "One or more imported files are invalid.");
        }

        const uploadPath = normalizedPaths[index];
        const stripped = stripRootSegment(uploadPath, inferredRoot);
        if (!stripped) {
          continue;
        }

        if (stripped.split("/").includes(".git")) {
          continue;
        }

        const destinationPath = resolve(targetRoot, stripped);
        if (!isWithinRoot(targetRoot, destinationPath)) {
          throw new PragmaError("INVALID_CODE_IMPORT", 400, "Import path is out of bounds.");
        }

        await mkdir(dirname(destinationPath), { recursive: true });
        const buffer = Buffer.from(await fileEntry.arrayBuffer());
        await writeFile(destinationPath, buffer);
        copiedFileCount += 1;
      }
    } catch (error: unknown) {
      await rm(targetRoot, { recursive: true, force: true });
      if (error instanceof PragmaError) {
        throw error;
      }
      throw new PragmaError("IMPORT_CODE_FOLDER_FAILED", 400, errorMessage(error));
    }

    if (copiedFileCount === 0) {
      await rm(targetRoot, { recursive: true, force: true });
      throw new PragmaError("INVALID_CODE_IMPORT", 400, "No importable files were found.");
    }

    const folders = await listCodeFolders(paths.codeDir);
    return c.json({ ok: true, folder: { name: folderName }, folders }, 201);
  });

  app.post("/code/folders/:name/push", async (c) => {
    const workspaceName = c.get("workspace");
    const paths = getWorkspacePaths(workspaceName);
    const folderName = c.req.param("name");
    const folderPath = join(paths.codeDir, folderName);

    if (!(await pathExists(folderPath))) {
      throw new PragmaError("CODE_FOLDER_NOT_FOUND", 404, `Code folder not found: ${folderName}`);
    }

    if (!(await hasGitMarkerInFolder(folderPath))) {
      throw new PragmaError("NOT_A_GIT_REPO", 400, `Folder is not a git repository: ${folderName}`);
    }

    try {
      await runCommand({
        command: "git",
        args: ["push", "origin", "main"],
        cwd: folderPath,
        env: process.env,
      });
    } catch (error: unknown) {
      throw new PragmaError("GIT_PUSH_FAILED", 400, errorMessage(error));
    }

    const folders = await listCodeFolders(paths.codeDir);
    return c.json({ ok: true, folders });
  });

  app.get("/workspace/outputs/files", async (c) => {
    const workspaceName = c.get("workspace");
    const paths = getWorkspacePaths(workspaceName);
    const files = await listAllWorkspaceOutputFiles(paths.outputsDir);
    return c.json({ files });
  });

  app.get("/workspace/outputs/file/content", validateQuery(outputFileQuerySchema), async (c) => {
    const workspaceName = c.get("workspace");
    const paths = getWorkspacePaths(workspaceName);
    const { path: relativePath } = c.req.valid("query");
    const { absolutePath, normalizedPath } = resolveOutputPath(paths.outputsDir, relativePath);
    const fileInfo = await stat(absolutePath).catch(() => null);
    if (!fileInfo?.isFile()) {
      throw new PragmaError("OUTPUT_FILE_NOT_FOUND", 404, `Output file not found: ${normalizedPath}`);
    }
    const mime = lookupMimeType(absolutePath);
    if (!mime) {
      throw new PragmaError("OUTPUT_MIME_TYPE_UNKNOWN", 409, `Unknown mime type for ${normalizedPath}`);
    }
    const content = await readFile(absolutePath);
    return c.body(content, 200, {
      "content-type": mime,
      "content-disposition": `inline; filename="${basename(absolutePath)}"`,
      "cache-control": "no-store",
    });
  });

  app.get("/workspace/outputs/file/download", validateQuery(outputFileQuerySchema), async (c) => {
    const workspaceName = c.get("workspace");
    const paths = getWorkspacePaths(workspaceName);
    const { path: relativePath } = c.req.valid("query");
    const { absolutePath, normalizedPath } = resolveOutputPath(paths.outputsDir, relativePath);
    const fileInfo = await stat(absolutePath).catch(() => null);
    if (!fileInfo?.isFile()) {
      throw new PragmaError("OUTPUT_FILE_NOT_FOUND", 404, `Output file not found: ${normalizedPath}`);
    }
    const mime = lookupMimeType(absolutePath);
    if (!mime) {
      throw new PragmaError("OUTPUT_MIME_TYPE_UNKNOWN", 409, `Unknown mime type for ${normalizedPath}`);
    }
    const content = await readFile(absolutePath);
    return c.body(content, 200, {
      "content-type": mime,
      "content-disposition": `attachment; filename="${basename(absolutePath)}"`,
      "cache-control": "no-store",
    });
  });

  app.get("/context", async (c) => {
    const workspaceName = c.get("workspace");
    const paths = getWorkspacePaths(workspaceName);

    const context = await listContext(paths.contextDir);
    return c.json({ context });
  });

  app.post("/context/folders", validateJson(createContextFolderSchema), async (c) => {
    const workspaceName = c.get("workspace");
    const paths = getWorkspacePaths(workspaceName);
    const body = c.req.valid("json");

    const folderName = normalizeContextFolderName(body.name);
    const folderPath = join(paths.contextDir, folderName);
    try {
      await mkdir(folderPath, { recursive: false });
    } catch (error: unknown) {
      const message = errorMessage(error);
      if (message.includes("EEXIST")) {
        throw new PragmaError("CONTEXT_FOLDER_EXISTS", 409, "Folder already exists.");
      }
      throw new PragmaError("CREATE_CONTEXT_FOLDER_FAILED", 400, message);
    }

    return c.json({ ok: true, folder: { name: folderName } }, 201);
  });

  app.post("/context/files", validateJson(createContextFileSchema), async (c) => {
    const workspaceName = c.get("workspace");
    const paths = getWorkspacePaths(workspaceName);
    const body = c.req.valid("json");

    const fileName = normalizeContextFileName(body.name);
    const folderName =
      typeof body.folder === "string" && body.folder.length > 0
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
        throw new PragmaError("CONTEXT_FILE_EXISTS", 409, "File already exists.");
      }
      if (message.includes("ENOENT")) {
        throw new PragmaError(
          "CONTEXT_FOLDER_NOT_FOUND",
          404,
          "Folder does not exist.",
        );
      }
      throw new PragmaError("CREATE_CONTEXT_FILE_FAILED", 400, message);
    }

    return c.json({ ok: true, file: { path: relativePath } }, 201);
  });

  app.put("/context/file", validateJson(updateContextFileSchema), async (c) => {
    const workspaceName = c.get("workspace");
    const paths = getWorkspacePaths(workspaceName);
    const body = c.req.valid("json");

    validateContextPath(body.path);
    const fullPath = join(paths.contextDir, body.path);
    try {
      await writeFile(fullPath, body.content, "utf8");
    } catch (error: unknown) {
      const message = errorMessage(error);
      if (message.includes("ENOENT")) {
        throw new PragmaError("CONTEXT_FILE_NOT_FOUND", 404, "File does not exist.");
      }
      throw new PragmaError("UPDATE_CONTEXT_FILE_FAILED", 400, message);
    }

    return c.json({ ok: true });
  });

  // ── Global Skills (from ~/.agents/skills and ~/.claude/skills) ─────

  function parseSkillMdDescription(content: string): string {
    // Try YAML frontmatter description
    const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (fmMatch) {
      const descMatch = fmMatch[1].match(/description:\s*["']?(.*?)["']?\s*$/m);
      if (descMatch && descMatch[1].trim()) return descMatch[1].trim();
    }
    // Fallback: first non-heading, non-empty line
    const lines = content.split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("---")) continue;
      return trimmed.length > 120 ? trimmed.slice(0, 120) + "..." : trimmed;
    }
    return "";
  }

  async function scanGlobalSkillsDir(dir: string, source: string): Promise<{ name: string; description: string; source: string; path: string }[]> {
    const results: { name: string; description: string; source: string; path: string }[] = [];
    let entries: string[];
    try {
      entries = await readdir(dir);
    } catch {
      return results;
    }
    for (const entry of entries) {
      if (entry.startsWith(".")) continue;
      const skillDir = join(dir, entry);
      try {
        const s = await stat(skillDir);
        if (!s.isDirectory()) continue;
      } catch {
        continue;
      }
      // Look for SKILL.md
      const skillMdPath = join(skillDir, "SKILL.md");
      let content: string;
      try {
        content = await readFile(skillMdPath, "utf-8");
      } catch {
        // No SKILL.md, skip
        continue;
      }
      const description = parseSkillMdDescription(content);
      // Try to extract name from frontmatter
      let name = entry;
      const fmMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
      if (fmMatch) {
        const nameMatch = fmMatch[1].match(/name:\s*["']?(.*?)["']?\s*$/m);
        if (nameMatch && nameMatch[1].trim()) name = nameMatch[1].trim();
      }
      results.push({ name, description, source, path: skillDir });
    }
    return results;
  }

  app.get("/skills/global", async (c) => {
    const harness = c.req.query("harness");
    const home = homedir();

    // If a harness is specified, use its globalSkillsDirs; otherwise fall back to legacy dirs
    let dirs: { dir: string; label: string }[];
    if (harness) {
      try {
        const def = getAdapterDefinition(harness);
        dirs = def.globalSkillsDirs ?? [];
      } catch {
        dirs = [];
      }
    } else {
      dirs = [
        { dir: ".claude/skills", label: "Claude Code" },
        { dir: ".agents/skills", label: "Agents" },
      ];
    }

    const allSkills = await Promise.all(
      dirs.map((d) => scanGlobalSkillsDir(join(home, d.dir), `~/${d.dir}`)),
    );

    // Deduplicate by name (first dir wins)
    const seen = new Set<string>();
    const skills: { name: string; description: string; source: string; path: string }[] = [];
    for (const batch of allSkills) {
      for (const s of batch) {
        const key = s.name.toLowerCase();
        if (!seen.has(key)) {
          seen.add(key);
          skills.push(s);
        }
      }
    }
    skills.sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ skills });
  });

  // ── MCP Servers (from harness config files like ~/.claude.json) ─────

  app.get("/skills/mcp-servers", async (c) => {
    const harness = c.req.query("harness");
    const home = homedir();

    let configFiles: { path: string; key: string }[] = [];
    if (harness) {
      try {
        const def = getAdapterDefinition(harness);
        configFiles = def.mcpConfigFiles ?? [];
      } catch {
        configFiles = [];
      }
    }

    const servers: { name: string; source: string }[] = [];
    for (const cfg of configFiles) {
      const filePath = join(home, cfg.path);
      try {
        const raw = await readFile(filePath, "utf-8");
        const parsed = JSON.parse(raw);
        const serverMap = parsed[cfg.key];
        if (serverMap && typeof serverMap === "object" && !Array.isArray(serverMap)) {
          for (const serverName of Object.keys(serverMap)) {
            servers.push({ name: serverName, source: `~/${cfg.path}` });
          }
        }
      } catch {
        // File missing or invalid JSON — skip silently
      }
    }

    servers.sort((a, b) => a.name.localeCompare(b.name));
    return c.json({ servers });
  });

  // ── Connectors ──────────────────────────────────────────────────────

  // In-memory OAuth state store (state string -> { connectorId, expiresAt })
  const oauthStateStore = new Map<string, { connectorId: string; expiresAt: number }>();

  // Track pending proxy-OAuth flows so /connectors/proxy-callback only accepts
  // callbacks that correlate with a flow this server actually initiated.
  // Key = connectorId, value = { expiresAt }.
  const pendingProxyOAuthFlows = new Map<string, { expiresAt: number }>();

  async function seedConnectors(db: Awaited<ReturnType<typeof openDatabase>>): Promise<void> {
    // Ensure display_name column exists for older databases
    await db.exec(`ALTER TABLE connectors ADD COLUMN IF NOT EXISTS display_name VARCHAR(255)`);
    await db.exec(`ALTER TABLE connectors ADD COLUMN IF NOT EXISTS is_custom BOOLEAN NOT NULL DEFAULT false`);
    // Relax NOT NULL constraints for custom connectors (older DBs may have stricter columns)
    await db.exec(`ALTER TABLE connectors ALTER COLUMN provider SET DEFAULT ''`);
    await db.exec(`ALTER TABLE connectors ALTER COLUMN binary_name SET DEFAULT ''`);
    await db.exec(`ALTER TABLE connectors ALTER COLUMN env_var SET DEFAULT ''`);
    await db.exec(`ALTER TABLE connectors ALTER COLUMN oauth_auth_url SET DEFAULT ''`);
    await db.exec(`ALTER TABLE connectors ALTER COLUMN oauth_token_url SET DEFAULT ''`);
    for (const def of CONNECTOR_REGISTRY) {
      await db.query(
        `INSERT INTO connectors (id, name, display_name, description, content, provider, binary_name,
         env_var, auth_type, oauth_auth_url, oauth_token_url, scopes)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (name) DO UPDATE SET display_name = EXCLUDED.display_name`,
        [
          `conn_${randomUUID().slice(0, 12)}`,
          def.name,
          def.displayName,
          def.description,
          def.content,
          def.provider,
          def.binaryName,
          def.envVar,
          def.authType,
          def.oauthAuthUrl,
          def.oauthTokenUrl,
          def.scopes,
        ],
      );
    }
  }

  async function refreshConnectorToken(
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
    // api_key connectors don't expire
    if (connector.auth_type === "api_key") {
      return connector.access_token!;
    }

    // If not expired, return current token
    if (
      connector.token_expires_at &&
      new Date(connector.token_expires_at) > new Date()
    ) {
      return connector.access_token!;
    }

    if (!connector.refresh_token) {
      throw new Error("No refresh token available — connector needs re-authorization");
    }

    // Check if this connector uses the OAuth proxy (only if no custom credentials)
    const registryDef = CONNECTOR_REGISTRY.find((d) => d.name === connector.name);
    const hasCustomCredentials = !!connector.oauth_client_id && !!connector.oauth_client_secret;
    let response: Response;

    if (registryDef?.proxyProvider && !hasCustomCredentials) {
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
      throw new Error("Token refresh failed — connector disconnected");
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

  // GET /connectors — list all connectors
  app.get("/connectors", async (c) => {
    const workspaceName = c.get("workspace");
    const db = c.get("db");

    await seedConnectors(db);

    const result = await db.query<{
      id: string;
      name: string;
      display_name: string | null;
      description: string | null;
      provider: string;
      status: string;
      auth_type: string;
      oauth_client_id: string | null;
      oauth_client_secret: string | null;
      is_custom: boolean;
    }>(
      `SELECT id, name, display_name, description, provider, status, auth_type,
              oauth_client_id, oauth_client_secret, is_custom
       FROM connectors ORDER BY name ASC`,
    );

    const connectors = result.rows.map((row) => {
      const registryDef = CONNECTOR_REGISTRY.find((d) => d.name === row.name);
      return {
        id: row.id,
        name: row.name,
        display_name: row.display_name,
        description: row.description,
        provider: row.provider,
        status: row.status,
        auth_type: row.auth_type,
        has_proxy: !!registryDef?.proxyProvider,
        has_client_id: !!row.oauth_client_id,
        has_client_secret: !!row.oauth_client_secret,
        is_custom: !!row.is_custom,
      };
    });

    return c.json({ connectors });
  });

  // POST /connectors — create custom connector
  app.post("/connectors", validateJson(createCustomConnectorSchema), async (c) => {
    const origin = c.req.header("origin") ?? c.req.header("referer");
    if (!isLoopbackOrigin(origin)) {
      throw new PragmaError("FORBIDDEN_ORIGIN", 403, "Request origin is not allowed");
    }
    const db = c.get("db");
    const body = c.req.valid("json");

    const id = `conn_${randomUUID().slice(0, 12)}`;
    const redirectUri = `http://127.0.0.1:${options.port}/connectors/callback`;

    if (body.auth_type === "api_key") {
      await db.query(
        `INSERT INTO connectors (id, name, display_name, description, content, provider, binary_name,
         env_var, auth_type, oauth_auth_url, oauth_token_url, scopes, redirect_uri,
         access_token, status, is_custom)
         VALUES ($1, $2, $3, $4, $5, '', '', '', 'api_key', '', '', '', $6, $7, $8, true)`,
        [
          id,
          body.name,
          body.name,
          body.description ?? null,
          body.content,
          redirectUri,
          body.access_token ?? null,
          body.access_token ? "connected" : "disconnected",
        ],
      );
    } else {
      await db.query(
        `INSERT INTO connectors (id, name, display_name, description, content, provider, binary_name,
         env_var, auth_type, oauth_client_id, oauth_client_secret, oauth_auth_url, oauth_token_url,
         scopes, redirect_uri, status, is_custom)
         VALUES ($1, $2, $3, $4, $5, '', '', '', 'oauth2', $6, $7, $8, $9, $10, $11, 'disconnected', true)`,
        [
          id,
          body.name,
          body.name,
          body.description ?? null,
          body.content,
          body.oauth_client_id ?? null,
          body.oauth_client_secret ?? null,
          body.oauth_auth_url ?? "",
          body.oauth_token_url ?? "",
          body.scopes ?? "",
          redirectUri,
        ],
      );
    }

    return c.json({ id, name: body.name }, 201);
  });

  // PUT /connectors/:id — update custom connector
  app.put("/connectors/:id", validateJson(updateCustomConnectorSchema), async (c) => {
    const origin = c.req.header("origin") ?? c.req.header("referer");
    if (!isLoopbackOrigin(origin)) {
      throw new PragmaError("FORBIDDEN_ORIGIN", 403, "Request origin is not allowed");
    }
    const db = c.get("db");
    const connectorId = c.req.param("id");
    const body = c.req.valid("json");

    const existing = await db.query<{ id: string; is_custom: boolean }>(
      `SELECT id, is_custom FROM connectors WHERE id = $1 LIMIT 1`,
      [connectorId],
    );
    if (existing.rows.length === 0) {
      throw new PragmaError("CONNECTOR_NOT_FOUND", 404, `Connector not found: ${connectorId}`);
    }
    if (!existing.rows[0].is_custom) {
      throw new PragmaError("CONNECTOR_NOT_CUSTOM", 400, "Only custom connectors can be edited");
    }

    const sets: string[] = [];
    const params: unknown[] = [connectorId];
    let idx = 2;
    const addField = (col: string, val: unknown) => {
      sets.push(`${col} = $${idx++}`);
      params.push(val);
    };

    if (body.name !== undefined) {
      addField("name", body.name);
      addField("display_name", body.name);
    }
    if (body.description !== undefined) addField("description", body.description || null);
    if (body.content !== undefined) addField("content", body.content);
    if (body.auth_type !== undefined) addField("auth_type", body.auth_type);
    if (body.oauth_client_id !== undefined) addField("oauth_client_id", body.oauth_client_id || null);
    if (body.oauth_client_secret !== undefined) addField("oauth_client_secret", body.oauth_client_secret || null);
    if (body.oauth_auth_url !== undefined) addField("oauth_auth_url", body.oauth_auth_url);
    if (body.oauth_token_url !== undefined) addField("oauth_token_url", body.oauth_token_url);
    if (body.scopes !== undefined) addField("scopes", body.scopes);
    if (body.access_token !== undefined) {
      addField("access_token", body.access_token || null);
      if (body.access_token) {
        addField("status", "connected");
      }
    }

    if (sets.length > 0) {
      await db.query(`UPDATE connectors SET ${sets.join(", ")} WHERE id = $1`, params);
    }

    return c.json({ ok: true });
  });

  // DELETE /connectors/:id — delete custom connector
  app.delete("/connectors/:id", async (c) => {
    const origin = c.req.header("origin") ?? c.req.header("referer");
    if (!isLoopbackOrigin(origin)) {
      throw new PragmaError("FORBIDDEN_ORIGIN", 403, "Request origin is not allowed");
    }
    const db = c.get("db");
    const connectorId = c.req.param("id");

    const existing = await db.query<{ id: string; is_custom: boolean }>(
      `SELECT id, is_custom FROM connectors WHERE id = $1 LIMIT 1`,
      [connectorId],
    );
    if (existing.rows.length === 0) {
      throw new PragmaError("CONNECTOR_NOT_FOUND", 404, `Connector not found: ${connectorId}`);
    }
    if (!existing.rows[0].is_custom) {
      throw new PragmaError("CONNECTOR_NOT_CUSTOM", 400, "Only custom connectors can be deleted");
    }

    await db.query(`DELETE FROM connectors WHERE id = $1`, [connectorId]);
    return c.json({ ok: true });
  });

  // PUT /connectors/:id/config — set client_id/secret or api_key
  app.put("/connectors/:id/config", validateJson(configureConnectorSchema), async (c) => {
    const origin = c.req.header("origin") ?? c.req.header("referer");
    if (!isLoopbackOrigin(origin)) {
      throw new PragmaError("FORBIDDEN_ORIGIN", 403, "Request origin is not allowed");
    }
    const workspaceName = c.get("workspace");
    const connectorId = c.req.param("id");
    const body = c.req.valid("json");

    const db = c.get("db");
    const existing = await db.query<{
      id: string;
      name: string;
      auth_type: string;
    }>(`SELECT id, name, auth_type FROM connectors WHERE id = $1 LIMIT 1`, [connectorId]);

    if (existing.rows.length === 0) {
      throw new PragmaError("CONNECTOR_NOT_FOUND", 404, `Connector not found: ${connectorId}`);
    }

    const connector = existing.rows[0];

    if (connector.auth_type === "api_key" && body.access_token) {
      // For api_key connectors, setting the token directly connects
      await db.query(
        `UPDATE connectors SET access_token = $1, status = 'connected' WHERE id = $2`,
        [body.access_token, connectorId],
      );
    } else {
      // OAuth connectors — store client credentials (including proxy-managed connectors for manual config)
      const sets: string[] = [];
      const params: unknown[] = [connectorId];
      let paramIndex = 2;

      if (body.oauth_client_id !== undefined) {
        sets.push(`oauth_client_id = $${paramIndex++}`);
        params.push(body.oauth_client_id || null);
      }
      if (body.oauth_client_secret !== undefined) {
        sets.push(`oauth_client_secret = $${paramIndex++}`);
        params.push(body.oauth_client_secret || null);
      }

      if (sets.length > 0) {
        // Set status to disconnected (ready to connect) if it was needs_config
        sets.push(`status = 'disconnected'`);
        await db.query(`UPDATE connectors SET ${sets.join(", ")} WHERE id = $1`, params);
      }
    }

    return c.json({ ok: true });
  });

  // GET /connectors/:id/auth — start OAuth flow
  app.get("/connectors/:id/auth", async (c) => {
    const workspaceName = c.get("workspace");
    const connectorId = c.req.param("id");

    const db = c.get("db");
    const result = await db.query<{
      id: string;
      name: string;
      oauth_client_id: string | null;
      oauth_client_secret: string | null;
      oauth_auth_url: string;
      scopes: string;
      redirect_uri: string;
      auth_type: string;
    }>(
      `SELECT id, name, oauth_client_id, oauth_client_secret, oauth_auth_url,
              scopes, redirect_uri, auth_type
       FROM connectors WHERE id = $1 LIMIT 1`,
      [connectorId],
    );

    if (result.rows.length === 0) {
      throw new PragmaError("CONNECTOR_NOT_FOUND", 404, `Connector not found: ${connectorId}`);
    }

    const connector = result.rows[0];

    if (connector.auth_type !== "oauth2") {
      throw new PragmaError("INVALID_AUTH_TYPE", 400, "This connector does not use OAuth2");
    }

    // Check if this connector uses the OAuth proxy (only if no custom credentials are configured)
    const registryDef = CONNECTOR_REGISTRY.find((d) => d.name === connector.name);
    const hasCustomCredentials = !!connector.oauth_client_id && !!connector.oauth_client_secret;
    if (registryDef?.proxyProvider && !hasCustomCredentials) {
      // Record that we initiated a proxy OAuth flow for this connector so the
      // proxy-callback endpoint can verify the callback is expected.
      pendingProxyOAuthFlows.set(connectorId, {
        expiresAt: Date.now() + 10 * 60 * 1000, // 10 min
      });
      const proxyUrl = `${OAUTH_PROXY_URL}/auth/${registryDef.proxyProvider}?connector_id=${connectorId}&port=${options.port}`;
      return c.json({ url: proxyUrl });
    }

    if (!connector.oauth_client_id || !connector.oauth_client_secret) {
      throw new PragmaError("CONNECTOR_NOT_CONFIGURED", 400, "Client ID and secret must be configured first");
    }

    const state = randomUUID();
    oauthStateStore.set(state, {
      connectorId: connector.id,
      expiresAt: Date.now() + 5 * 60 * 1000,
    });

    // Clean up expired states
    for (const [key, value] of oauthStateStore) {
      if (value.expiresAt < Date.now()) {
        oauthStateStore.delete(key);
      }
    }

    const params = new URLSearchParams({
      client_id: connector.oauth_client_id,
      redirect_uri: connector.redirect_uri,
      scope: connector.scopes,
      state,
      response_type: "code",
      access_type: "offline",
      prompt: "consent",
    });

    const url = `${connector.oauth_auth_url}?${params.toString()}`;

    return c.json({ url });
  });

  // POST /connectors/proxy-callback — OAuth proxy callback (tokens sent via POST body)
  app.post("/connectors/proxy-callback", async (c) => {
    const body = await c.req.parseBody();
    const accessToken = typeof body.access_token === "string" ? body.access_token : undefined;
    const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : undefined;
    const expiresIn = typeof body.expires_in === "string" ? body.expires_in : undefined;
    const connectorId = typeof body.connector_id === "string" ? body.connector_id : undefined;
    const error = typeof body.error === "string" ? body.error : undefined;

    if (error) {
      // Still consume the pending flow on errors so it doesn't linger.
      if (connectorId) pendingProxyOAuthFlows.delete(connectorId);
      return c.html(
        `<html><body><h2>Error</h2><p>${escapeHtml(error)}</p><button onclick="window.close()">Close</button></body></html>`,
        400,
      );
    }

    if (!accessToken || !connectorId) {
      return c.html(
        "<html><body><h2>Error</h2><p>Missing required parameters.</p></body></html>",
        400,
      );
    }

    // Verify this callback correlates to a proxy OAuth flow this server initiated.
    const pendingFlow = pendingProxyOAuthFlows.get(connectorId);
    if (!pendingFlow || pendingFlow.expiresAt < Date.now()) {
      pendingProxyOAuthFlows.delete(connectorId);
      return c.html(
        "<html><body><h2>Error</h2><p>No pending OAuth flow for this connector. Please try connecting again.</p></body></html>",
        403,
      );
    }
    pendingProxyOAuthFlows.delete(connectorId);

    const workspaceName = c.get("workspace");
    const db = c.get("db");

    const result = await db.query<{ id: string }>(
      `SELECT id FROM connectors WHERE id = $1 LIMIT 1`,
      [connectorId],
    );

    if (result.rows.length === 0) {
      return c.html(
        "<html><body><h2>Error</h2><p>Connector not found.</p></body></html>",
        404,
      );
    }

    const tokenExpiresAt = expiresIn
      ? new Date(Date.now() + Number(expiresIn) * 1000).toISOString()
      : new Date(Date.now() + 3600 * 1000).toISOString();

    await db.query(
      `UPDATE connectors
       SET access_token = $1, refresh_token = $2, token_expires_at = $3, status = 'connected'
       WHERE id = $4`,
      [accessToken, refreshToken ?? null, tokenExpiresAt, connectorId],
    );

    return c.html(
      `<html><body><h2>Connected!</h2><p>You can close this tab.</p><script>window.close()</script></body></html>`,
    );
  });

  // GET /connectors/callback — OAuth callback
  app.get("/connectors/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");

    if (!code || !state) {
      return c.html("<html><body><h2>Error</h2><p>Missing code or state parameter.</p></body></html>", 400);
    }

    const stateEntry = oauthStateStore.get(state);
    if (!stateEntry || stateEntry.expiresAt < Date.now()) {
      oauthStateStore.delete(state);
      return c.html("<html><body><h2>Error</h2><p>Invalid or expired state. Please try connecting again.</p></body></html>", 400);
    }
    oauthStateStore.delete(state);

    const workspaceName = c.get("workspace");
    const db = c.get("db");

    const result = await db.query<{
      id: string;
      oauth_client_id: string;
      oauth_client_secret: string;
      oauth_token_url: string;
      redirect_uri: string;
    }>(
      `SELECT id, oauth_client_id, oauth_client_secret, oauth_token_url, redirect_uri
       FROM connectors WHERE id = $1 LIMIT 1`,
      [stateEntry.connectorId],
    );

    if (result.rows.length === 0) {
      return c.html("<html><body><h2>Error</h2><p>Connector not found.</p></body></html>", 404);
    }

    const connector = result.rows[0];

    // Exchange code for tokens
    const tokenResponse = await fetch(connector.oauth_token_url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        client_id: connector.oauth_client_id,
        client_secret: connector.oauth_client_secret,
        redirect_uri: connector.redirect_uri,
      }),
    });

    if (!tokenResponse.ok) {
      const errorBody = await tokenResponse.text().catch(() => "");
      console.error(`OAuth token exchange failed: ${tokenResponse.status} ${errorBody}`);
      return c.html("<html><body><h2>Error</h2><p>Token exchange failed. Please try again.</p></body></html>", 500);
    }

    const tokenData = (await tokenResponse.json()) as {
      access_token: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const expiresAt = new Date(
      Date.now() + (tokenData.expires_in ?? 3600) * 1000,
    ).toISOString();

    await db.query(
      `UPDATE connectors
       SET access_token = $1, refresh_token = $2, token_expires_at = $3, status = 'connected'
       WHERE id = $4`,
      [
        tokenData.access_token,
        tokenData.refresh_token ?? null,
        expiresAt,
        connector.id,
      ],
    );

    return c.html(
      `<html><body><h2>Connected!</h2><p>You can close this tab.</p><script>window.close()</script></body></html>`,
    );
  });

  // DELETE /connectors/:id/auth — disconnect
  app.delete("/connectors/:id/auth", async (c) => {
    const origin = c.req.header("origin") ?? c.req.header("referer");
    if (!isLoopbackOrigin(origin)) {
      throw new PragmaError("FORBIDDEN_ORIGIN", 403, "Request origin is not allowed");
    }
    const workspaceName = c.get("workspace");
    const connectorId = c.req.param("id");

    const db = c.get("db");
    await db.query(
      `UPDATE connectors
       SET status = 'disconnected', access_token = NULL,
           refresh_token = NULL, token_expires_at = NULL
       WHERE id = $1`,
      [connectorId],
    );
    return c.json({ ok: true });
  });

  // POST /connectors/:id/ensure-binary — download binary on demand
  app.post("/connectors/:id/ensure-binary", async (c) => {
    const origin = c.req.header("origin") ?? c.req.header("referer");
    if (!isLoopbackOrigin(origin)) {
      throw new PragmaError("FORBIDDEN_ORIGIN", 403, "Request origin is not allowed");
    }
    const workspaceName = c.get("workspace");
    const connectorId = c.req.param("id");

    const db = c.get("db");
    const result = await db.query<{ name: string }>(
      `SELECT name FROM connectors WHERE id = $1 LIMIT 1`,
      [connectorId],
    );

    if (result.rows.length === 0) {
      throw new PragmaError("CONNECTOR_NOT_FOUND", 404, `Connector not found: ${connectorId}`);
    }

    const def = CONNECTOR_REGISTRY.find((d) => d.name === result.rows[0].name);
    if (!def) {
      throw new PragmaError("CONNECTOR_DEF_NOT_FOUND", 404, "Connector definition not found in registry");
    }

    const platform = process.platform === "darwin" ? "darwin" : "linux";
    const arch = process.arch === "arm64" ? "arm64" : "x64";
    const downloadUrl = def.getBinaryUrl(platform, arch);
    const binPath = await ensureConnectorBinary(def.binaryName, downloadUrl, workspaceName);

    return c.json({ ok: true, path: binPath });
  });

  // ── Agent-Connector Assignments ──────────────────────────────────

  // GET /agents/:id/connectors
  app.get("/agents/:id/connectors", async (c) => {
    const workspaceName = c.get("workspace");
    const agentId = c.req.param("id");

    const db = c.get("db");
    const agent = await db.query<{ id: string }>(
      `SELECT id FROM agents WHERE id = $1 LIMIT 1`,
      [agentId],
    );
    if (agent.rows.length === 0) {
      throw new PragmaError("AGENT_NOT_FOUND", 404, `Agent not found: ${agentId}`);
    }

    const result = await db.query<{
      id: string;
      name: string;
      description: string | null;
      status: string;
    }>(
      `SELECT c.id, c.name, c.description, c.status
       FROM connectors c
       JOIN agent_connectors ac ON ac.connector_id = c.id
       WHERE ac.agent_id = $1
       ORDER BY c.name ASC`,
      [agentId],
    );

    return c.json({ connectors: result.rows });
  });

  // POST /agents/:id/connectors — assign connector
  app.post("/agents/:id/connectors", validateJson(assignAgentConnectorSchema), async (c) => {
    const workspaceName = c.get("workspace");
    const agentId = c.req.param("id");
    const body = c.req.valid("json");

    const db = c.get("db");
    const agent = await db.query<{ id: string }>(
      `SELECT id FROM agents WHERE id = $1 LIMIT 1`,
      [agentId],
    );
    if (agent.rows.length === 0) {
      throw new PragmaError("AGENT_NOT_FOUND", 404, `Agent not found: ${agentId}`);
    }

    const connector = await db.query<{ id: string }>(
      `SELECT id FROM connectors WHERE id = $1 LIMIT 1`,
      [body.connector_id],
    );
    if (connector.rows.length === 0) {
      throw new PragmaError("CONNECTOR_NOT_FOUND", 404, `Connector not found: ${body.connector_id}`);
    }

    await db.query(
      `INSERT INTO agent_connectors (agent_id, connector_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [agentId, body.connector_id],
    );

    return c.json({ ok: true }, 201);
  });

  // DELETE /agents/:id/connectors/:connId — unassign connector
  app.delete("/agents/:id/connectors/:connId", async (c) => {
    const workspaceName = c.get("workspace");
    const agentId = c.req.param("id");
    const connId = c.req.param("connId");

    const db = c.get("db");
    const result = await db.query(
      `DELETE FROM agent_connectors WHERE agent_id = $1 AND connector_id = $2`,
      [agentId, connId],
    );
    if ((result.affectedRows ?? 0) === 0) {
      throw new PragmaError(
        "AGENT_CONNECTOR_NOT_FOUND",
        404,
        `Connector assignment not found for agent ${agentId} and connector ${connId}`,
      );
    }

    return c.json({ ok: true });
  });

  // GET /agents/:id/connectors/:connId/content — connector skill markdown
  app.get("/agents/:id/connectors/:connId/content", async (c) => {
    const workspaceName = c.get("workspace");
    const agentId = c.req.param("id");
    const connId = c.req.param("connId");

    const db = c.get("db");
    const result = await db.query<{ content: string }>(
      `SELECT c.content
       FROM connectors c
       JOIN agent_connectors ac ON ac.connector_id = c.id
       WHERE ac.agent_id = $1 AND c.id = $2
       LIMIT 1`,
      [agentId, connId],
    );

    if (result.rows.length === 0) {
      throw new PragmaError(
        "AGENT_CONNECTOR_NOT_FOUND",
        404,
        `Connector not found or not assigned to agent ${agentId}`,
      );
    }

    return c.text(result.rows[0].content);
  });

  // ── Skills CRUD ────────────────────────────────────────────────────

  app.get("/skills", async (c) => {
    const workspaceName = c.get("workspace");
    const db = c.get("db");

    const result = await db.query<{
      id: string;
      name: string;
      description: string | null;
      content: string;
    }>(`SELECT id, name, description, content FROM skills ORDER BY name ASC`);

    return c.json({ skills: result.rows });
  });

  app.post("/skills", validateJson(createSkillSchema), async (c) => {
    const workspaceName = c.get("workspace");
    const body = c.req.valid("json");

    const db = c.get("db");
    try {
      const skillId = `skill_${randomUUID().slice(0, 12)}`;
      await db.query(
        `INSERT INTO skills (id, name, description, content) VALUES ($1, $2, $3, $4)`,
        [skillId, body.name, body.description ?? null, body.content],
      );

      return c.json({ ok: true, id: skillId }, 201);
    } catch (error: unknown) {
      const message = errorMessage(error);
      if (message.includes("unique") || message.includes("duplicate")) {
        throw new PragmaError("SKILL_NAME_EXISTS", 409, `A skill with this name already exists.`);
      }
      throw new PragmaError("CREATE_SKILL_FAILED", 400, message);
    }
  });

  app.put("/skills/:id", validateJson(updateSkillSchema), async (c) => {
    const workspaceName = c.get("workspace");
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const db = c.get("db");
    const existing = await db.query<{ id: string }>(
      `SELECT id FROM skills WHERE id = $1 LIMIT 1`,
      [id],
    );
    if (existing.rows.length === 0) {
      throw new PragmaError("SKILL_NOT_FOUND", 404, `Skill not found: ${id}`);
    }

    const sets: string[] = [];
    const params: unknown[] = [id];
    let paramIndex = 2;

    if (body.name !== undefined) {
      sets.push(`name = $${paramIndex++}`);
      params.push(body.name);
    }
    if (body.description !== undefined) {
      sets.push(`description = $${paramIndex++}`);
      params.push(body.description);
    }
    if (body.content !== undefined) {
      sets.push(`content = $${paramIndex++}`);
      params.push(body.content);
    }

    if (sets.length > 0) {
      await db.query(`UPDATE skills SET ${sets.join(", ")} WHERE id = $1`, params);
    }

    return c.json({ ok: true });
  });

  app.delete("/skills/:id", async (c) => {
    const workspaceName = c.get("workspace");
    const id = c.req.param("id");

    const db = c.get("db");
    const result = await db.query(`DELETE FROM skills WHERE id = $1`, [id]);
    if ((result.affectedRows ?? 0) === 0) {
      throw new PragmaError("SKILL_NOT_FOUND", 404, `Skill not found: ${id}`);
    }

    return c.json({ ok: true });
  });

  // ── Agent-Skill Assignments ────────────────────────────────────────

  app.get("/agents/:id/skills", async (c) => {
    const workspaceName = c.get("workspace");
    const agentId = c.req.param("id");

    const db = c.get("db");
    const agent = await db.query<{ id: string }>(
      `SELECT id FROM agents WHERE id = $1 LIMIT 1`,
      [agentId],
    );
    if (agent.rows.length === 0) {
      throw new PragmaError("AGENT_NOT_FOUND", 404, `Agent not found: ${agentId}`);
    }

    const result = await db.query<{
      id: string;
      name: string;
      description: string | null;
    }>(
      `SELECT s.id, s.name, s.description
       FROM skills s
       JOIN agent_skills as_rel ON as_rel.skill_id = s.id
       WHERE as_rel.agent_id = $1
       ORDER BY s.name ASC`,
      [agentId],
    );

    return c.json({ skills: result.rows });
  });

  app.post("/agents/:id/skills", validateJson(assignAgentSkillSchema), async (c) => {
    const workspaceName = c.get("workspace");
    const agentId = c.req.param("id");
    const body = c.req.valid("json");

    const db = c.get("db");
    const agent = await db.query<{ id: string }>(
      `SELECT id FROM agents WHERE id = $1 LIMIT 1`,
      [agentId],
    );
    if (agent.rows.length === 0) {
      throw new PragmaError("AGENT_NOT_FOUND", 404, `Agent not found: ${agentId}`);
    }

    const skill = await db.query<{ id: string }>(
      `SELECT id FROM skills WHERE id = $1 LIMIT 1`,
      [body.skill_id],
    );
    if (skill.rows.length === 0) {
      throw new PragmaError("SKILL_NOT_FOUND", 404, `Skill not found: ${body.skill_id}`);
    }

    await db.query(
      `INSERT INTO agent_skills (agent_id, skill_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [agentId, body.skill_id],
    );

    return c.json({ ok: true }, 201);
  });

  app.delete("/agents/:id/skills/:skillId", async (c) => {
    const workspaceName = c.get("workspace");
    const agentId = c.req.param("id");
    const skillId = c.req.param("skillId");

    const db = c.get("db");
    const result = await db.query(
      `DELETE FROM agent_skills WHERE agent_id = $1 AND skill_id = $2`,
      [agentId, skillId],
    );
    if ((result.affectedRows ?? 0) === 0) {
      throw new PragmaError(
        "AGENT_SKILL_NOT_FOUND",
        404,
        `Skill assignment not found for agent ${agentId} and skill ${skillId}`,
      );
    }

    return c.json({ ok: true });
  });

  app.get("/agents/:id/skills/:skillId/content", async (c) => {
    const workspaceName = c.get("workspace");
    const agentId = c.req.param("id");
    const skillId = c.req.param("skillId");

    const db = c.get("db");
    const result = await db.query<{ content: string }>(
      `SELECT s.content
       FROM skills s
       JOIN agent_skills as_rel ON as_rel.skill_id = s.id
       WHERE as_rel.agent_id = $1 AND s.id = $2
       LIMIT 1`,
      [agentId, skillId],
    );

    if (result.rows.length === 0) {
      throw new PragmaError(
        "AGENT_SKILL_NOT_FOUND",
        404,
        `Skill not found or not assigned to agent ${agentId}`,
      );
    }

    return c.text(result.rows[0].content);
  });

  app.onError((error, c) => {
    if (error instanceof PragmaError) {
      return c.newResponse(
        JSON.stringify({ error: error.code, message: error.message }),
        toKnownStatusCode(error.status),
        { "content-type": "application/json" },
      );
    }

    const message = errorMessage(error);
    return c.json({ error: "INTERNAL_ERROR", message }, 500);
  });

  const server = serve({ fetch: app.fetch, port: options.port }, (info) => {
    console.log(`Pragma API listening on http://127.0.0.1:${info.port}`);
  });

  const shutdown = () => {
    for (const [, store] of RUNTIME_SERVICES_BY_WORKSPACE) {
      for (const service of store.values()) {
        if (service.status === "running" || service.status === "ready") {
          try {
            if (service.pid && service.pid > 0) {
              process.kill(service.pid, "SIGTERM");
            }
          } catch {
            // Process may already be dead
          }
        }
      }
    }

    server.close();
    void closeOpenDatabases().finally(() => {
      process.exit(0);
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}


async function detectProcessCommands(
  workspaceName: string,
  folderName: string,
  workspacePaths: ReturnType<typeof getWorkspacePaths>,
  db: PGlite,
): Promise<void> {
  try {
    const folderPath = join(workspacePaths.codeDir, folderName);

    // Read key files to detect commands
    const detectedProcesses: Array<{ label: string; command: string; cwd: string; type: string }> = [];

    // Check for package.json
    try {
      const pkgJson = JSON.parse(await readFile(join(folderPath, "package.json"), "utf8"));
      const scripts = pkgJson.scripts || {};
      for (const [name, cmd] of Object.entries(scripts)) {
        if (typeof cmd !== "string") continue;
        if (name === "dev" || name === "start" || name === "serve") {
          detectedProcesses.push({ label: `${name} (npm)`, command: `npm run ${name}`, cwd: ".", type: "service" });
        } else if (name === "build" || name === "test" || name === "lint") {
          detectedProcesses.push({ label: `${name} (npm)`, command: `npm run ${name}`, cwd: ".", type: "script" });
        }
      }
    } catch { /* no package.json */ }

    // Check for Makefile
    try {
      const makefile = await readFile(join(folderPath, "Makefile"), "utf8");
      const targets = makefile.match(/^([a-zA-Z_][a-zA-Z0-9_-]*):/gm);
      if (targets) {
        for (const target of targets.slice(0, 5)) {
          const name = target.replace(":", "");
          if (["run", "serve", "dev", "start"].includes(name)) {
            detectedProcesses.push({ label: `make ${name}`, command: `make ${name}`, cwd: ".", type: "service" });
          } else if (["build", "test", "lint", "clean"].includes(name)) {
            detectedProcesses.push({ label: `make ${name}`, command: `make ${name}`, cwd: ".", type: "script" });
          }
        }
      }
    } catch { /* no Makefile */ }

    // Check for pyproject.toml
    try {
      await stat(join(folderPath, "pyproject.toml"));
      detectedProcesses.push({ label: "Python Dev", command: "python -m uvicorn main:app --reload", cwd: ".", type: "service" });
    } catch { /* no pyproject.toml */ }

    // Check for Cargo.toml
    try {
      await stat(join(folderPath, "Cargo.toml"));
      detectedProcesses.push({ label: "Cargo Run", command: "cargo run", cwd: ".", type: "service" });
      detectedProcesses.push({ label: "Cargo Build", command: "cargo build", cwd: ".", type: "script" });
    } catch { /* no Cargo.toml */ }

    // Check for docker-compose
    for (const dcFile of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
      try {
        await stat(join(folderPath, dcFile));
        detectedProcesses.push({ label: "Docker Compose Up", command: "docker compose up", cwd: ".", type: "service" });
        break;
      } catch { /* no docker-compose */ }
    }

    if (detectedProcesses.length === 0) return;

    // Deduplicate: skip processes that already exist for this folder
    const existing = await db.query<{ command: string; cwd: string }>(
      `SELECT command, cwd FROM processes WHERE workspace = $1 AND folder_name = $2`,
      [workspaceName, folderName],
    );
    const existingKeys = new Set(existing.rows.map((r) => `${r.command}::${r.cwd}`));

    for (const proc of detectedProcesses) {
      const key = `${proc.command}::${proc.cwd}`;
      if (existingKeys.has(key)) continue;
      existingKeys.add(key);

      const processId = `proc_${randomUUID().slice(0, 12)}`;
      await db.query(
        `INSERT INTO processes (id, workspace, folder_name, label, command, cwd, type, status)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'stopped')`,
        [processId, workspaceName, folderName, proc.label, proc.command, proc.cwd, proc.type],
      );
    }
  } catch (error) {
    console.error(`[detect] Failed to detect processes for ${folderName}:`, error);
  }
}

async function isDirectoryEmpty(path: string): Promise<boolean> {
  try {
    const entries = await readdir(path);
    return entries.length === 0;
  } catch {
    return true;
  }
}

function safeParseJson(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractTaskFailureMessage(payloadJson: string | null | undefined): string | null {
  if (typeof payloadJson !== "string" || payloadJson.trim().length === 0) {
    return null;
  }

  const parsed = safeParseJson(payloadJson) as { message?: unknown } | null;
  const rawMessage = typeof parsed?.message === "string" ? parsed.message.trim() : "";
  if (!rawMessage) {
    return null;
  }

  const message = rawMessage.replace(/\s+/g, " ");

  if (message.length > 280) {
    return `${message.slice(0, 277)}...`;
  }
  return message;
}

function deriveChatTitle(userMessage: string, assistantMessage: string): string {
  const userFirst = firstSentence(userMessage);
  if (userFirst) {
    return truncateChatText(userFirst, 80);
  }

  const assistantFirst = firstSentence(assistantMessage);
  if (assistantFirst) {
    return truncateChatText(assistantFirst, 80);
  }

  return "New chat";
}

function derivePendingPlanMetadata(
  firstUserMessage: string | null,
): { title: string; preview: string | null } {
  const title = firstUserMessage ? truncateChatText(firstUserMessage, 80) : "";
  const preview = firstUserMessage ? truncateChatText(firstUserMessage, 140) : "";

  return {
    title: title || "New plan",
    preview: preview || null,
  };
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



function buildConversationAgentEnv(input: {
  apiUrl: string;
  pragmaCliCommand: string;
  workspaceName: string;
  threadId: string;
  turnId: string;
  agentId: string;
  taskId?: string | null;
}): Record<string, string> {
  const env: Record<string, string> = {
    PRAGMA_API_URL: input.apiUrl,
    PRAGMA_CLI_COMMAND: input.pragmaCliCommand,
    PRAGMA_WORKSPACE_NAME: input.workspaceName,
    PRAGMA_THREAD_ID: input.threadId,
    PRAGMA_TURN_ID: input.turnId,
    PRAGMA_AGENT_ID: input.agentId,
  };

  if (input.taskId && input.taskId.trim()) {
    env.PRAGMA_TASK_ID = input.taskId;
  }

  return env;
}

function buildConflictRetryPrompt(input: {
  originalTask: string;
  conflicts: Array<{
    repo_path: string;
    files: string[];
    taskRepoPath: string;
    branchName: string;
    baseBranch: string;
    mainChangesSummary: string;
  }>;
}): string {
  const conflictSections = input.conflicts
    .map((conflict) => {
      const files =
        conflict.files.length > 0
          ? conflict.files.map((file) => `- ${file}`).join("\n")
          : "- (git reported conflict without explicit file list)";

      const mainChanges = conflict.mainChangesSummary
        ? conflict.mainChangesSummary
        : "(no commits found touching conflicted files)";

      return [
        `### Repo: ${conflict.repo_path}`,
        `**Path in worktree:** ${conflict.taskRepoPath}`,
        `**Merge state:** MERGING (merge already initiated — do NOT run \`git merge\`)`,
        `**Task branch:** ${conflict.branchName}  ←  merging in: ${conflict.baseBranch}`,
        "",
        "Conflicted files:",
        files,
        "",
        `Commits that landed on ${conflict.baseBranch} since this task branched (touching conflicted files):`,
        mainChanges,
      ].join("\n");
    })
    .join("\n\n");

  return [
    "The approval merge for this task hit conflicts. Resolve them in the task worktree.",
    "",
    "## Conflict Details",
    "",
    conflictSections,
    "",
    "## Important: Worktree Structure",
    "",
    "Each repo listed above is a **nested git repository** inside the task worktree.",
    "You MUST run all git commands (git add, git commit, git status, etc.) from the repo path shown above, NOT from the outer workspace directory.",
    "",
    "## Resolution Steps",
    "",
    "1. Open each conflicted file and resolve the conflict markers (`<<<<<<<` / `=======` / `>>>>>>>`)",
    "2. Incorporate main's intent (e.g. if main deleted code, don't reintroduce it; if main added code, keep it)",
    "3. `git add <resolved-file>` in the repo directory shown above",
    "4. `git commit` to complete the merge (git supplies the merge commit message)",
    "5. Verify: `git status` should show a clean working tree with no conflict markers in any file",
    "",
    "## Original Task",
    "",
    input.originalTask.trim(),
  ].join("\n");
}

async function getTaskOutputsRoot(
  db: Awaited<ReturnType<typeof openDatabase>>,
  workspacePaths: ReturnType<typeof getWorkspacePaths>,
  taskId: string,
): Promise<string> {
  const result = await db.query<{ id: string; output_dir: string | null }>(
    `
SELECT id, output_dir
FROM tasks
WHERE id = $1
LIMIT 1
`,
    [taskId],
  );

  const row = result.rows[0];
  if (!row) {
    throw new PragmaError("TASK_NOT_FOUND", 404, `Task not found: ${taskId}`);
  }

  return resolveTaskOutputsRoot(workspacePaths, taskId, row.output_dir);
}

async function resolveTaskOutputsRoot(
  workspacePaths: ReturnType<typeof getWorkspacePaths>,
  taskId: string,
  storedOutputDir?: string | null,
): Promise<string> {
  const mainRoot = resolve(join(workspacePaths.outputsDir, taskId));
  const worktreeRoot = resolve(
    join(workspacePaths.worktreesDir, taskId, "workspace", "outputs", taskId),
  );

  if (typeof storedOutputDir !== "string" || storedOutputDir.trim().length === 0) {
    return mainRoot;
  }

  const absolute = resolve(storedOutputDir.trim());
  if (!isWithinRoot(mainRoot, absolute) && !isWithinRoot(worktreeRoot, absolute)) {
    throw new PragmaError("TASK_OUTPUT_DIR_INVALID", 409, `Task output directory is invalid: ${taskId}`);
  }
  if (!(await isDirectory(absolute))) {
    if (isWithinRoot(mainRoot, absolute)) {
      await mkdir(absolute, { recursive: true });
      return absolute;
    }
    if (isWithinRoot(worktreeRoot, absolute)) {
      await mkdir(mainRoot, { recursive: true });
      return mainRoot;
    }
    throw new PragmaError("TASK_OUTPUT_DIR_NOT_FOUND", 409, `Task output directory not found: ${taskId}`);
  }
  return absolute;
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

async function listAllWorkspaceOutputFiles(
  outputsDir: string,
): Promise<Array<{ path: string; size: number; modified_at: string }>> {
  if (!(await isDirectory(outputsDir))) {
    return [];
  }

  const files: Array<{ path: string; size: number; modified_at: string }> = [];
  await walkWorkspaceOutputFiles(outputsDir, outputsDir, files, { count: 0 }, 0);
  files.sort((a, b) => b.modified_at.localeCompare(a.modified_at));
  return files;
}

async function walkWorkspaceOutputFiles(
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

    const fullPath = join(currentDir, entry.name);
    if (entry.isDirectory()) {
      await walkWorkspaceOutputFiles(rootDir, fullPath, files, state, depth + 1);
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
    throw new PragmaError("INVALID_OUTPUT_PATH", 400, "Output path is required.");
  }
  if (value.includes("\0")) {
    throw new PragmaError("INVALID_OUTPUT_PATH", 400, "Output path is invalid.");
  }
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new PragmaError("INVALID_OUTPUT_PATH", 400, "Output path must be relative.");
  }

  const normalized = value.replace(/\\/g, "/").replace(/^\.\/+/, "");
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw new PragmaError("INVALID_OUTPUT_PATH", 400, "Output path is invalid.");
  }
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new PragmaError("INVALID_OUTPUT_PATH", 400, "Output path cannot traverse directories.");
  }

  const normalizedPath = segments.join("/");
  const root = resolve(outputsRoot);
  const absolutePath = resolve(root, normalizedPath);
  if (absolutePath !== root && !absolutePath.startsWith(`${root}${sep}`)) {
    throw new PragmaError("INVALID_OUTPUT_PATH", 400, "Output path is out of bounds.");
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

async function openFolder(targetPath: string): Promise<void> {
  const fullPath = resolve(targetPath);
  const fileInfo = await stat(fullPath).catch(() => null);
  if (!fileInfo) {
    throw new PragmaError("OUTPUT_PATH_NOT_FOUND", 404, "Path does not exist.");
  }

  try {
    await open(fullPath, { wait: false });
  } catch (error: unknown) {
    throw new PragmaError("OPEN_FOLDER_FAILED", 400, errorMessage(error));
  }
}

async function isDirectory(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return Boolean(info?.isDirectory());
}


function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function requireReasoningEffort(
  value: ReasoningEffort | null | undefined,
  source: string,
): ReasoningEffort {
  if (!value) {
    throw new PragmaError("MISSING_REASONING_EFFORT", 409, `Reasoning effort missing for ${source}.`);
  }
  return value;
}

function toKnownStatusCode(status: number): 400 | 404 | 409 | 422 {
  if (status === 404) {
    return 404;
  }
  if (status === 409) {
    return 409;
  }
  if (status === 422) {
    return 422;
  }
  return 400;
}

function validateContextPath(path: string): void {
  if (!path || path.trim().length === 0) {
    throw new PragmaError("INVALID_CONTEXT_PATH", 400, "Path is required.");
  }

  if (!path.toLowerCase().endsWith(".md")) {
    throw new PragmaError(
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
    throw new PragmaError(
      "INVALID_CONTEXT_PATH",
      400,
      "Invalid context path.",
    );
  }

  const parts = path.split("/");
  if (parts.length > 2 || parts.some((part) => part.trim().length === 0)) {
    throw new PragmaError(
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
    throw new PragmaError("INVALID_CONTEXT_FILE", 400, "File name is required.");
  }
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    trimmed.includes("\0")
  ) {
    throw new PragmaError("INVALID_CONTEXT_FILE", 400, "Invalid file name.");
  }
  if (!trimmed.toLowerCase().endsWith(".md")) {
    throw new PragmaError("INVALID_CONTEXT_FILE", 400, "File name must end with .md.");
  }
  return trimmed;
}

function normalizeContextFolderName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) {
    throw new PragmaError("INVALID_CONTEXT_FOLDER", 400, "Folder name is required.");
  }
  if (
    trimmed.includes("/") ||
    trimmed.includes("\\") ||
    trimmed.includes("..") ||
    trimmed.includes("\0")
  ) {
    throw new PragmaError("INVALID_CONTEXT_FOLDER", 400, "Invalid folder name.");
  }
  return trimmed;
}

type TaskTestCommand = {
  label: string;
  command: string;
  cwd: string;
};

function parseTaskTestCommands(value: string | null | undefined): TaskTestCommand[] {
  if (!value || typeof value !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) {
      return [];
    }
    return normalizeTaskTestCommands(parsed);
  } catch {
    return [];
  }
}

function normalizeTaskTestCommands(input: unknown, limit = 8): TaskTestCommand[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const commands: TaskTestCommand[] = [];
  const seen = new Set<string>();
  for (const item of input) {
    if (!item || typeof item !== "object") {
      continue;
    }
    const record = item as Record<string, unknown>;
    const command =
      typeof record.command === "string" ? record.command.trim() : "";
    const labelSource =
      typeof record.label === "string" ? record.label.trim() : "";
    const cwdSource = typeof record.cwd === "string" ? record.cwd.trim() : "";
    const cwd = normalizeTaskTestCommandCwd(cwdSource);
    if (!command || !cwd) {
      continue;
    }
    const key = `${cwd}\n${command}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    commands.push({
      label: labelSource || command,
      command,
      cwd,
    });
    if (commands.length >= limit) {
      break;
    }
  }

  return commands;
}

function isDisallowedHumanOnlyTestCommand(command: string): boolean {
  const normalized = command.trim().toLowerCase();
  if (!normalized) {
    return true;
  }

  const disallowedPatterns: RegExp[] = [
    /\blint\b/,
    /\beslint\b/,
    /\bprettier\b/,
    /\bformat\b/,
    /\bfmt\b/,
    /\btypecheck\b/,
    /\btsc\b/,
    /\bbuild\b/,
    /\bcompile\b/,
    /\btest\b/,
    /\bjest\b/,
    /\bvitest\b/,
    /\bmocha\b/,
    /\bava\b/,
    /\bpytest\b/,
    /\brspec\b/,
    /\bcargo\s+test\b/,
    /\bgo\s+test\b/,
  ];

  return disallowedPatterns.some((pattern) => pattern.test(normalized));
}

async function resolveTaskExecutionRoot(
  workspacePaths: ReturnType<typeof getWorkspacePaths>,
  taskId: string,
): Promise<string> {
  const worktreeRoot = resolve(join(workspacePaths.worktreesDir, taskId, "workspace"));
  if (await isDirectory(worktreeRoot)) {
    return worktreeRoot;
  }
  return workspacePaths.workspaceDir;
}

function normalizeTaskTestCommandCwd(value: string): string {
  if (!value) {
    return "";
  }
  const normalized = value
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .trim();
  if (!normalized || normalized.includes("\0")) {
    return "";
  }
  return normalized;
}

async function resolveTaskCommandCwd(baseDir: string, requestedCwd: string): Promise<string> {
  const normalized = normalizeTaskTestCommandCwd(requestedCwd);
  if (!normalized) {
    throw new PragmaError("INVALID_TEST_COMMAND_CWD", 400, "Test command cwd is invalid.");
  }

  const candidate = resolve(
    normalized.startsWith("/") ? normalized : join(baseDir, normalized),
  );
  if (!isWithinRoot(baseDir, candidate)) {
    throw new PragmaError(
      "INVALID_TEST_COMMAND_CWD",
      400,
      "Test command cwd must stay within the task workspace.",
    );
  }
  if (!(await isDirectory(candidate))) {
    throw new PragmaError(
      "INVALID_TEST_COMMAND_CWD",
      400,
      `Test command cwd does not exist: ${requestedCwd}`,
    );
  }
  return candidate;
}

type CodeFolderSummary = {
  name: string;
  path: string;
  is_git_repo: boolean;
  git_branch: string | null;
  git_default_branch: string | null;
  git_remote: string | null;
  git_dirty: boolean | null;
  git_last_commit_hash: string | null;
  git_last_commit_message: string | null;
  git_last_commit_at: string | null;
  git_unpushed_count: number | null;
};

async function listCodeFolders(codeDir: string): Promise<CodeFolderSummary[]> {
  const entries = await readdir(codeDir, { withFileTypes: true }).catch(() => []);
  const folderNames = entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));

  const summaries = await Promise.all(folderNames.map((name) => buildCodeFolderSummary(codeDir, name)));

  return summaries.filter((folder) => {
    if (folder.name !== "default") return true;
    return !isEmptyDefaultRepo(folder);
  });
}

function isEmptyDefaultRepo(folder: CodeFolderSummary): boolean {
  if (!folder.is_git_repo) return false;
  if (folder.git_dirty) return false;
  return (
    folder.git_last_commit_message === "pragma: initialize default code repo" &&
    folder.git_unpushed_count === null
  );
}

async function buildCodeFolderSummary(
  codeDir: string,
  name: string,
): Promise<CodeFolderSummary> {
  const folderPath = join(codeDir, name);
  const base: CodeFolderSummary = {
    name,
    path: `code/${name}`,
    is_git_repo: false,
    git_branch: null,
    git_default_branch: null,
    git_remote: null,
    git_dirty: null,
    git_last_commit_hash: null,
    git_last_commit_message: null,
    git_last_commit_at: null,
    git_unpushed_count: null,
  };

  if (!(await hasGitMarkerInFolder(folderPath))) {
    return base;
  }

  const insideGitRepo = (await runGitCaptureOptional(folderPath, ["rev-parse", "--is-inside-work-tree"])) === "true";
  if (!insideGitRepo) {
    return base;
  }

  const branch = await runGitCaptureOptional(folderPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const remote = await runGitCaptureOptional(folderPath, ["config", "--get", "remote.origin.url"]);
  const remoteHead = await runGitCaptureOptional(folderPath, [
    "symbolic-ref",
    "--quiet",
    "--short",
    "refs/remotes/origin/HEAD",
  ]);
  const statusPorcelain = await runGitCaptureOptional(folderPath, ["status", "--porcelain"]);
  const lastCommit = await runGitCaptureOptional(folderPath, [
    "log",
    "-1",
    "--pretty=format:%h%x1f%s%x1f%cI",
  ]);
  const [lastCommitHash = "", lastCommitMessage = "", lastCommitAt = ""] = (lastCommit || "")
    .split("\u001f")
    .map((value) => value.trim());

  let unpushedCount: number | null = null;
  if (remote) {
    const unpushedRaw = await runGitCaptureOptional(folderPath, [
      "rev-list",
      "--count",
      "@{upstream}..HEAD",
    ]);
    if (unpushedRaw !== null && /^\d+$/.test(unpushedRaw.trim())) {
      unpushedCount = parseInt(unpushedRaw.trim(), 10);
    }
  }

  return {
    ...base,
    is_git_repo: true,
    git_branch: normalizeOptionalGitValue(branch),
    git_default_branch: normalizeGitDefaultBranch(remoteHead),
    git_remote: normalizeOptionalGitValue(remote),
    git_dirty: typeof statusPorcelain === "string" ? statusPorcelain.trim().length > 0 : null,
    git_last_commit_hash: normalizeOptionalGitValue(lastCommitHash),
    git_last_commit_message: normalizeOptionalGitValue(lastCommitMessage),
    git_last_commit_at: normalizeOptionalGitValue(lastCommitAt),
    git_unpushed_count: unpushedCount,
  };
}

async function hasGitMarkerInFolder(path: string): Promise<boolean> {
  const marker = await stat(join(path, ".git")).catch(() => null);
  return Boolean(marker?.isDirectory() || marker?.isFile());
}

async function runGitCaptureOptional(cwd: string, args: string[]): Promise<string | null> {
  try {
    const output = await runCommand({
      command: "git",
      args,
      cwd,
      env: process.env,
    });
    return output.trim();
  } catch {
    return null;
  }
}

function normalizeGitDefaultBranch(value: string | null): string | null {
  const normalized = normalizeOptionalGitValue(value);
  if (!normalized) {
    return null;
  }
  const marker = "origin/";
  const index = normalized.indexOf(marker);
  if (index < 0) {
    return normalized;
  }
  return normalized.slice(index + marker.length) || null;
}

function normalizeOptionalGitValue(value: string | null | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function deriveCodeFolderNameFromGitUrl(gitUrl: string): string {
  const trimmed = gitUrl.trim();
  const cleaned = trimmed.replace(/[?#].*$/, "");
  const match = cleaned.match(/([^/:]+?)(?:\.git)?$/i);
  return match?.[1] ?? "repo";
}

function normalizeCodeFolderName(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "");

  if (!normalized || normalized === "." || normalized === "..") {
    throw new PragmaError("INVALID_CODE_FOLDER", 400, "Code folder name is invalid.");
  }

  return normalized;
}

function normalizePickedLocalPath(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  if (trimmed === "/") {
    return trimmed;
  }
  return trimmed.replace(/\/+$/, "");
}

function normalizeImportedPath(path: string): string {
  const normalized = path
    .replace(/\\/g, "/")
    .replace(/^\/+/, "")
    .replace(/^\.\/+/, "")
    .trim();

  if (!normalized) {
    throw new PragmaError("INVALID_CODE_IMPORT", 400, "Import path is invalid.");
  }
  if (normalized.includes("\0")) {
    throw new PragmaError("INVALID_CODE_IMPORT", 400, "Import path is invalid.");
  }

  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => segment === "." || segment === "..")) {
    throw new PragmaError("INVALID_CODE_IMPORT", 400, "Import path is invalid.");
  }

  return segments.join("/");
}

function stripRootSegment(path: string, rootSegment: string): string {
  const segments = path.split("/").filter(Boolean);
  if (segments.length <= 1) {
    return "";
  }
  if (segments[0] === rootSegment) {
    return segments.slice(1).join("/");
  }
  return segments.join("/");
}

async function pathExists(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return Boolean(info);
}

type UploadedFileLike = {
  arrayBuffer: () => Promise<ArrayBuffer>;
};

function isUploadedFile(value: unknown): value is UploadedFileLike {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return typeof candidate.arrayBuffer === "function";
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
