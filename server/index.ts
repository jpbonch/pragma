import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { cp, mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import { serve } from "@hono/node-server";
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
import { getConversationAdapter } from "./conversation/adapters";
import { generateTitle } from "./conversation/titleGenerator";
import { ExecuteRunner } from "./conversation/executeRunner";
import {
  buildRepoDiffEntries,
  deleteTaskWorktree,
  getMainChangesSummary,
  getTaskMainOutputDir,
  mergeApprovedTask,
  parseTaskGitState,
  resolveRepoPath,
  saveDiffSnapshot,
} from "./conversation/gitWorkflow";
import { resolveModelId } from "./conversation/models";
import { buildPrompt } from "./conversation/prompts";
import { resolvePragmaCliCommand } from "./conversation/pragmaCli";
import {
  closeThread,
  createThread,
  createTurn,
  ensureConversationSchema,
  getLatestCompletedPlanTurn,
  getFirstExecuteTurn,
  getLatestExecuteTurn,
  getThreadByTaskId,
  getThreadById,
  getThreadWithDetails,
  insertEvent,
  insertMessage,
  listChatThreads,
  listOpenPlanThreads,
  reopenThread,
  setThreadTaskId,
  updateChatThreadMetadata,
  updateThreadSession,
  completeTurn,
  failTurn,
} from "./conversation/store";
import type { HarnessId, TaskStatus, ReasoningEffort } from "./conversation/types";
import {
  agentSubmitTestCommandsSchema,
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
  createTaskSchema,
  createWorkspaceSchema,
  executeFromThreadSchema,
  tasksQuerySchema,
  taskRespondSchema,
  openOutputFolderSchema,
  outputFileQuerySchema,
  plansQuerySchema,
  planSelectRecipientSchema,
  reviewTaskSchema,
  runTaskTestCommandSchema,
  updateTaskTestCommandsSchema,
  setActiveWorkspaceSchema,
  setTaskRecipientSchema,
  updateAgentSchema,
  updateContextFileSchema,
  updateHumanSchema,
  createSkillSchema,
  updateSkillSchema,
  assignAgentSkillSchema,
} from "./http/schemas";
import { validateJson, validateQuery } from "./http/validators";
import { runCommand, spawnShellCommand } from "./process/runCommand";

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

type RuntimeServiceStatus = "running" | "exited" | "stopped";
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
};

const TASK_STATUS_LISTENERS = new Map<string, Set<TaskStatusListener>>();
const THREAD_UPDATE_LISTENERS = new Map<string, Set<ThreadUpdateListener>>();
const RUNTIME_SERVICES_BY_WORKSPACE = new Map<string, Map<string, RuntimeServiceRecord>>();
const MAX_RUNTIME_SERVICE_LOG_ENTRIES = 2000;

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
  if (service.logs.length > MAX_RUNTIME_SERVICE_LOG_ENTRIES) {
    service.logs.splice(0, service.logs.length - MAX_RUNTIME_SERVICE_LOG_ENTRIES);
  }
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
}

function startRuntimeService(input: {
  workspaceName: string;
  taskId: string;
  label: string;
  command: string;
  requestedCwd: string;
  absoluteCwd: string;
  env: NodeJS.ProcessEnv;
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
    exit_code: null,
    started_at: startedAt,
    ended_at: null,
    absolute_cwd: input.absoluteCwd,
    stop_requested: false,
    next_seq: 1,
    logs: [],
    listeners: new Set<RuntimeServiceListener>(),
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

  child.stdout?.on("data", (chunk) => {
    appendRuntimeServiceLog(service, "stdout", String(chunk ?? ""));
  });
  child.stderr?.on("data", (chunk) => {
    appendRuntimeServiceLog(service, "stderr", String(chunk ?? ""));
  });
  child.on("error", (error) => {
    appendRuntimeServiceLog(service, "system", `[spawn error] ${errorMessage(error)}\n`);
    if (service.status === "running") {
      updateRuntimeServiceStatus(service, service.stop_requested ? "stopped" : "exited", -1);
    }
  });
  child.on("exit", (code) => {
    if (service.status !== "running") {
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
  if (service.status !== "running") {
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
    if (service.status !== "running") {
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

export async function startServer(options: StartServerOptions): Promise<void> {
  await setupPragma();
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

  const app = new Hono();
  app.use("*", cors());
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

  app.get("/health", (c) => c.json({ ok: true }));

  app.get("/cli/available", async (c) => {
    const execFileAsync = promisify(execFile);
    const whichCommand = process.platform === "win32" ? "where" : "which";

    const clis: { id: string; command: string; available: boolean }[] = [
      { id: "claude_code", command: "claude", available: false },
      { id: "codex", command: "codex", available: false },
    ];

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

  app.post("/uploads", async (c) => {
    const MAX_FILE_SIZE = 50 * 1024 * 1024; // 50MB

    const workspaceName = await requireActiveWorkspaceName();
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
    const workspaceName = await requireActiveWorkspaceName();
    const db = await openDatabase(workspaceName);

    try {
      const result = await db.query<{
        id: string;
        name: string;
        description: string | null;
        status: string;
        agent_file: string | null;
        emoji: string | null;
        harness: HarnessId;
        model_label: string;
        model_id: string;
      }>(`
SELECT id, name, description, status, agent_file, emoji, harness, model_label, model_id
FROM agents
ORDER BY name ASC
`);

      return c.json({ agents: result.rows });
    } finally {
      await db.close();
    }
  });

  app.post("/agents", validateJson(createAgentSchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const body = c.req.valid("json");

    const db = await openDatabase(workspaceName);
    try {
      const harness = body.harness;
      const modelLabel = body.model_label;
      const modelId = resolveModelId(harness, modelLabel);
      const agentId = await generateNextAgentId(db, body.name);
      await db.query(
        `
INSERT INTO agents (id, name, description, status, agent_file, emoji, harness, model_label, model_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
`,
        [
          agentId,
          body.name,
          body.description ?? null,
          "idle",
          body.agent_file,
          body.emoji,
          harness,
          modelLabel,
          modelId,
        ],
      );

      return c.json({ ok: true, id: agentId }, 201);
    } catch (error: unknown) {
      const message = errorMessage(error);
      throw new PragmaError("CREATE_AGENT_FAILED", 400, message);
    } finally {
      await db.close();
    }
  });

  app.put("/agents/:id", validateJson(updateAgentSchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const db = await openDatabase(workspaceName);
    try {
      const modelId = resolveModelId(body.harness, body.model_label);
      const updated = await db.query(
        `
UPDATE agents
SET name = $2,
    description = $3,
    agent_file = $4,
    emoji = $5,
    harness = $6,
    model_label = $7,
    model_id = $8
WHERE id = $1
`,
        [
          id,
          body.name,
          body.description ?? null,
          body.agent_file,
          body.emoji,
          body.harness,
          body.model_label,
          modelId,
        ],
      );

      if ((updated.affectedRows ?? 0) === 0) {
        throw new PragmaError("AGENT_NOT_FOUND", 404, `Agent not found: ${id}`);
      }

      return c.json({ ok: true });
    } finally {
      await db.close();
    }
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
    const workspaceName = await requireActiveWorkspaceName();
    const db = await openDatabase(workspaceName);

    try {
      const result = await db.query<{
        id: string;
        emoji: string;
        created_at: string;
      }>(`SELECT id, emoji, created_at FROM humans ORDER BY created_at ASC`);

      return c.json({ humans: result.rows });
    } finally {
      await db.close();
    }
  });

  app.post("/humans", validateJson(createHumanSchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const body = c.req.valid("json");
    const db = await openDatabase(workspaceName);

    try {
      const id = randomUUID().slice(0, 12);
      await db.query(
        `INSERT INTO humans (id, emoji) VALUES ($1, $2)`,
        [id, body.emoji],
      );

      return c.json({ ok: true, id }, 201);
    } catch (error: unknown) {
      const message = errorMessage(error);
      throw new PragmaError("CREATE_HUMAN_FAILED", 400, message);
    } finally {
      await db.close();
    }
  });

  app.put("/humans/:id", validateJson(updateHumanSchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const id = c.req.param("id");
    const body = c.req.valid("json");
    const db = await openDatabase(workspaceName);

    try {
      const updated = await db.query(
        `UPDATE humans SET emoji = $2 WHERE id = $1`,
        [id, body.emoji],
      );

      if ((updated.affectedRows ?? 0) === 0) {
        throw new PragmaError("HUMAN_NOT_FOUND", 404, `Human not found: ${id}`);
      }

      return c.json({ ok: true });
    } finally {
      await db.close();
    }
  });

  app.delete("/humans/:id", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const id = c.req.param("id");
    const db = await openDatabase(workspaceName);

    try {
      const deleted = await db.query(
        `DELETE FROM humans WHERE id = $1`,
        [id],
      );

      if ((deleted.affectedRows ?? 0) === 0) {
        throw new PragmaError("HUMAN_NOT_FOUND", 404, `Human not found: ${id}`);
      }

      return c.json({ ok: true });
    } finally {
      await db.close();
    }
  });

  app.get("/tasks", validateQuery(tasksQuerySchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const { status, limit } = c.req.valid("query");

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
       j.completed_at,
       (
         SELECT ct.id
         FROM conversation_threads ct
         WHERE ct.task_id = j.id
         ORDER BY ct.created_at DESC
         LIMIT 1
       ) AS thread_id
FROM tasks j
`;

      if (status) {
        query += "WHERE status = $2\n";
        params.push(status);
      }

      query += "ORDER BY created_at DESC\nLIMIT $1";

      const result = await db.query<{
        id: string;
        title: string;
        status: TaskStatus;
        assigned_to: string | null;
        output_dir: string | null;
        session_id: string | null;
        created_at: string;
        completed_at: string | null;
        thread_id: string | null;
      }>(query, params);

      return c.json({ tasks: result.rows });
    } finally {
      await db.close();
    }
  });

  app.get("/tasks/stream", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();

    c.header("cache-control", "no-store");
    c.header("connection", "keep-alive");

    return streamSSE(c, async (stream) => {
      let closed = false;
      const writeEvent = async (
        eventName: string,
        payload: Record<string, unknown>,
      ): Promise<void> => {
        if (closed) {
          return;
        }
        await stream.writeSSE({
          event: eventName,
          data: JSON.stringify(payload),
        });
      };

      await writeEvent("ready", { workspace: workspaceName, ts: new Date().toISOString() });

      const unsubscribe = subscribeTaskStatus(workspaceName, (event) => {
        void writeEvent("task_status_changed", event);
      });

      const pingTimer = setInterval(() => {
        void writeEvent("ping", { ts: new Date().toISOString() });
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

  app.get("/services", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    return c.json({ services: listRuntimeServices(workspaceName) });
  });

  app.post("/services/:serviceId/stop", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
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
    const workspaceName = await requireActiveWorkspaceName();
    const serviceId = c.req.param("serviceId");
    const service = getRuntimeService(workspaceName, serviceId);
    if (!service) {
      throw new PragmaError("SERVICE_NOT_FOUND", 404, `Service not found: ${serviceId}`);
    }

    c.header("cache-control", "no-store");
    c.header("connection", "keep-alive");

    return streamSSE(c, async (stream) => {
      let closed = false;
      const writeEvent = async (
        eventName: string,
        payload: Record<string, unknown>,
      ): Promise<void> => {
        if (closed) {
          return;
        }
        await stream.writeSSE({
          event: eventName,
          data: JSON.stringify(payload),
        });
      };

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

      const pingTimer = setInterval(() => {
        void writeEvent("ping", { ts: new Date().toISOString() });
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
      service.listeners.delete(listener);
    });
  });

  app.get("/conversations/:threadId/stream", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const threadId = c.req.param("threadId");
    const db = await openDatabase(workspaceName);

    try {
      await ensureConversationSchema(db);
      const thread = await getThreadById(db, threadId);
      if (!thread) {
        throw new PragmaError("THREAD_NOT_FOUND", 404, `Conversation thread not found: ${threadId}`);
      }
    } finally {
      await db.close();
    }

    c.header("cache-control", "no-store");
    c.header("connection", "keep-alive");

    return streamSSE(c, async (stream) => {
      let closed = false;
      const writeEvent = async (
        eventName: string,
        payload: Record<string, unknown>,
      ): Promise<void> => {
        if (closed) {
          return;
        }
        await stream.writeSSE({
          event: eventName,
          data: JSON.stringify(payload),
        });
      };

      await writeEvent("ready", { thread_id: threadId, ts: new Date().toISOString() });

      const unsubscribe = subscribeThreadUpdates(workspaceName, threadId, (event) => {
        void writeEvent("thread_updated", event);
      });

      const pingTimer = setInterval(() => {
        void writeEvent("ping", { ts: new Date().toISOString() });
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

  app.get("/tasks/:taskId/output/changes", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const taskId =c.req.param("taskId");
    const db = await openDatabase(workspaceName);

    try {
      const taskResult = await db.query<{ id: string; status: string; git_state_json: string | null }>(
        `
SELECT id, status, git_state_json
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

      if (task.status === "completed" || task.status === "cancelled") {
        const snapshotPath = join(getTaskMainOutputDir(workspacePaths, taskId), ".changes.diff");
        try {
          const savedDiff = await readFile(snapshotPath, "utf-8");
          return c.json({
            roots: [join(workspacePaths.worktreesDir, taskId, "workspace")],
            repos: [],
            diff: savedDiff,
          });
        } catch {
          // Snapshot not found, fall through to live diff
        }
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
    } finally {
      await db.close();
    }
  });

  app.get("/tasks/:taskId/output/files", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const taskId =c.req.param("taskId");
    const db = await openDatabase(workspaceName);

    try {
      const workspacePaths = getWorkspacePaths(workspaceName);
      const outputsRoot = await getTaskOutputsRoot(db, workspacePaths, taskId);
      const files = await listOutputFiles(outputsRoot);

      return c.json({
        root: outputsRoot,
        files,
      });
    } finally {
      await db.close();
    }
  });

  app.get("/tasks/:taskId/output/file/content", validateQuery(outputFileQuerySchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const taskId =c.req.param("taskId");
    const { path: relativePath } = c.req.valid("query");
    const db = await openDatabase(workspaceName);

    try {
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
    } finally {
      await db.close();
    }
  });

  app.get("/tasks/:taskId/output/file/download", validateQuery(outputFileQuerySchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const taskId =c.req.param("taskId");
    const { path: relativePath } = c.req.valid("query");
    const db = await openDatabase(workspaceName);

    try {
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
    } finally {
      await db.close();
    }
  });

  app.post("/tasks/:taskId/output/open-folder", validateJson(openOutputFolderSchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const taskId =c.req.param("taskId");
    const body = c.req.valid("json");

    const db = await openDatabase(workspaceName);
    try {
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
    } finally {
      await db.close();
    }
  });

  app.get("/tasks/:taskId/plan", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const taskId = c.req.param("taskId");
    const db = await openDatabase(workspaceName);

    try {
      const result = await db.query<{ plan: string | null }>(
        `SELECT plan FROM tasks WHERE id = $1 LIMIT 1`,
        [taskId],
      );
      const plan = result.rows[0]?.plan?.trim() || null;
      return c.json({ plan });
    } finally {
      await db.close();
    }
  });

  app.get("/tasks/:taskId/test-commands", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const taskId =c.req.param("taskId");
    const db = await openDatabase(workspaceName);

    try {
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
    } finally {
      await db.close();
    }
  });

  app.put(
    "/tasks/:taskId/test-commands",
    validateJson(updateTaskTestCommandsSchema),
    async (c) => {
      const workspaceName = await requireActiveWorkspaceName();
      const taskId =c.req.param("taskId");
      const body = c.req.valid("json");
      const db = await openDatabase(workspaceName);

      try {
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
      } finally {
        await db.close();
      }
    },
  );

  app.post("/tasks/:taskId/test-commands/run", validateJson(runTaskTestCommandSchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const taskId =c.req.param("taskId");
    const body = c.req.valid("json");
    const db = await openDatabase(workspaceName);

    try {
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
    } finally {
      await db.close();
    }
  });

  app.post("/tasks/:taskId/review", validateJson(reviewTaskSchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const taskId =c.req.param("taskId");
    const body = c.req.valid("json");

    const db = await openDatabase(workspaceName);
    try {
      await ensureConversationSchema(db);

      const taskResult = await db.query<{
        id: string;
        status: TaskStatus;
        assigned_to: string | null;
        merge_retry_count: number | null;
        git_state_json: string | null;
      }>(
        `
SELECT id, status, assigned_to, merge_retry_count, git_state_json
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

      const pushAfterMerge = body.action === "approve_and_push";

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

        const assignedWorker =
          task.assigned_to && task.assigned_to !== DEFAULT_AGENT_ID
            ? await getAgentRow(db, task.assigned_to)
            : null;

        await db.query(
          `
UPDATE tasks
SET status = 'queued',
    merge_retry_count = 0,
    completed_at = NULL
WHERE id = $1
`,
          [taskId],
        );
        emitTaskStatus(workspaceName, taskId, "queued", "review_reopen");

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

        executeRunner.execute({
          workspaceName,
          taskId,
          threadId: thread.id,
          prompt: latestExecuteTurn.user_message,
          requestedRecipientAgentId: assignedWorker?.id ?? undefined,
          reasoningEffort: requireReasoningEffort(
            latestExecuteTurn.reasoning_effort,
            `latest execute turn for reopen task ${taskId}`,
          ),
        });

        return c.json({
          ok: true,
          status: "queued",
          reopen_state: "enqueued",
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
        throw new PragmaError(
          "TASK_GIT_STATE_MISSING",
          409,
          `Task has no git execution state: ${taskId}`,
        );
      }

      const workspacePaths = getWorkspacePaths(workspaceName);
      const mergeResult = await mergeApprovedTask({
        workspacePaths,
        taskId,
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
        await saveDiffSnapshot({ workspacePaths, taskId, gitState });
        await deleteTaskWorktree({ workspacePaths, taskId });

        if (pushAfterMerge) {
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

        return c.json({
          ok: true,
          status: nextStatus,
          merge_state: pushAfterMerge ? "merged_and_pushed" : "merged",
          conflicts: [],
        });
      }

      const retryCount = Number.isInteger(task.merge_retry_count) ? (task.merge_retry_count as number) : 0;
      if (retryCount < 1) {
        await db.query(
          `
UPDATE tasks
SET status = 'queued',
    merge_retry_count = COALESCE(merge_retry_count, 0) + 1
WHERE id = $1
`,
          [taskId],
        );
        emitTaskStatus(workspaceName, taskId, "queued", "review_conflict_retry");

        const thread = await getThreadByTaskId(db, taskId);
        const latestExecuteTurn = thread ? await getLatestExecuteTurn(db, thread.id) : null;
        if (thread && latestExecuteTurn && latestExecuteTurn.user_message.trim()) {
          const taskWorkspaceDir = join(workspacePaths.worktreesDir, taskId, "workspace");
          const enrichedConflicts = await Promise.all(
            mergeResult.conflicts.map(async (conflict) => {
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

          return c.json({
            ok: true,
            status: "queued",
            merge_state: "conflict_retry_enqueued",
            conflicts: mergeResult.conflicts,
          });
        }

        await db.query(
          `
UPDATE tasks
SET status = 'needs_fix'
WHERE id = $1
`,
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
        `
UPDATE tasks
SET status = 'needs_fix'
WHERE id = $1
`,
        [taskId],
      );
      emitTaskStatus(workspaceName, taskId, "needs_fix", "review_conflict_manual");
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

  app.delete("/tasks/:taskId", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const taskId =c.req.param("taskId");

    const db = await openDatabase(workspaceName);
    try {
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

      await deleteTaskWorktree({ workspacePaths, taskId });

      return c.json({ ok: true, status: "cancelled" });
    } finally {
      await db.close();
    }
  });

  app.post("/tasks", validateJson(createTaskSchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const body = c.req.valid("json");

    const taskId =`task_${randomUUID().slice(0, 8)}`;
    const status: TaskStatus = body.status;
    const db = await openDatabase(workspaceName);

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
    } finally {
      await db.close();
    }

    return c.json({ id: taskId }, 201);
  });

  app.post("/tasks/execute", validateJson(createExecuteTaskSchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const body = c.req.valid("json");
    const prompt = body.prompt;
    const reasoningEffort = body.reasoning_effort;
    const fallbackTitle = prompt.length > 100 ? `${prompt.slice(0, 97)}...` : prompt;
    const taskId =`task_${randomUUID().slice(0, 8)}`;
    const threadId = `thread_${randomUUID().slice(0, 12)}`;

    const db = await openDatabase(workspaceName);
    try {
      await ensureConversationSchema(db);

      const orchestrator = await getAgentRow(db, DEFAULT_AGENT_ID);
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

        const recipient = await getAgentRow(db, requestedRecipientAgentId);
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
      generateTitle(db, prompt, "").then((aiTitle) => {
        updateTaskTitle(db, taskId, aiTitle);
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
    } finally {
      await db.close();
    }

    return c.json({ task_id: taskId }, 201);
  });

  app.post("/tasks/:taskId/recipient", validateJson(setTaskRecipientSchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const taskId =c.req.param("taskId");
    const body = c.req.valid("json");
    const recipientAgentId = body.recipient_agent_id;
    const db = await openDatabase(workspaceName);

    try {
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

      const recipient = await getAgentRow(db, recipientAgentId);
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
    } finally {
      await db.close();
    }

    return c.json({ ok: true });
  });

  app.post(
    "/tasks/:taskId/agent/select-recipient",
    validateJson(agentSelectRecipientSchema),
    async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const taskId =c.req.param("taskId");
    const body = c.req.valid("json");
    const selectedAgentId = body.agent_id;
    const db = await openDatabase(workspaceName);

    try {
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

      const recipient = await getAgentRow(db, selectedAgentId);
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

    } finally {
      await db.close();
    }

    return c.json({ ok: true, assigned_to: selectedAgentId });
  });

  app.post(
    "/tasks/:taskId/agent/test-commands",
    validateJson(agentSubmitTestCommandsSchema),
    async (c) => {
      const workspaceName = await requireActiveWorkspaceName();
      const taskId =c.req.param("taskId");
      const body = c.req.valid("json");

      const db = await openDatabase(workspaceName);
      try {
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
      } finally {
        await db.close();
      }
    },
  );

  app.post("/tasks/:taskId/agent/ask-question", validateJson(agentAskQuestionSchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const taskId =c.req.param("taskId");
    const body = c.req.valid("json");

    const db = await openDatabase(workspaceName);
    try {
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
      emitTaskStatus(workspaceName, taskId, "waiting_for_question_response", "worker_ask_question");
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
SET status = 'waiting_for_question_response'
WHERE id = $1
`,
        [taskId],
      );
      emitTaskStatus(workspaceName, taskId, "waiting_for_question_response", "worker_ask_question");

      const thread = await getThreadByTaskId(db, taskId);
      if (thread) {
        const latestExecuteTurn = await getLatestExecuteTurn(db, thread.id);
        await insertEvent(db, {
          id: `evt_${randomUUID().slice(0, 12)}`,
          threadId: thread.id,
          turnId: body.turn_id || latestExecuteTurn?.id || null,
          eventName: "worker_question_requested",
          payload: {
            question: body.question,
            details: body.details ?? null,
            agent_id: body.agent_id ?? task.assigned_to ?? null,
          },
        });
      }

      return c.json({ ok: true, status: "waiting_for_question_response" });
    } finally {
      await db.close();
    }
  });

  app.post("/tasks/:taskId/agent/request-help", validateJson(agentRequestHelpSchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const taskId =c.req.param("taskId");
    const body = c.req.valid("json");

    const db = await openDatabase(workspaceName);
    try {
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
    } finally {
      await db.close();
    }
  });

  app.post("/tasks/:taskId/respond", validateJson(taskRespondSchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const taskId =c.req.param("taskId");
    const body = c.req.valid("json");

    const db = await openDatabase(workspaceName);
    let requeue: {
      threadId: string;
      prompt: string;
      recipientAgentId: string;
      reasoningEffort: ReasoningEffort;
      resumeWorkerSessionId: string | null;
      followUpMessage: string;
    } | null = null;

    try {
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
        task.status !== "waiting_for_help_response"
      ) {
        throw new PragmaError(
          "TASK_NOT_WAITING_FOR_RESPONSE",
          409,
          `Task is not waiting for a human response: ${taskId}`,
        );
      }
      if (!task.assigned_to) {
        throw new PragmaError(
          "TASK_MISSING_ASSIGNED_WORKER",
          409,
          `Task has no assigned worker to resume: ${taskId}`,
        );
      }
      const resumeWorker = await getAgentRow(db, task.assigned_to);
      if (!resumeWorker || resumeWorker.id === DEFAULT_AGENT_ID) {
        throw new PragmaError(
          "TASK_INVALID_ASSIGNED_WORKER",
          409,
          `Assigned worker is invalid for task resume: ${taskId}`,
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
    } finally {
      await db.close();
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

    return c.json({ ok: true, status: "queued" });
  });

  app.post(
    "/conversations/:threadId/turns/:turnId/agent/select-recipient",
    validateJson(planSelectRecipientSchema),
    async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const threadId = c.req.param("threadId");
    const turnId = c.req.param("turnId");
    const body = c.req.valid("json");

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
      const recipient = await getAgentRow(db, selectedAgentId);
      if (!recipient || recipient.id === DEFAULT_AGENT_ID) {
        const candidates = await listPlanWorkerCandidates(db);
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
    } finally {
      await db.close();
    }
  });

  app.get("/conversations/chats", validateQuery(chatsQuerySchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const { limit, cursor } = c.req.valid("query");
    const db = await openDatabase(workspaceName);

    try {
      await ensureConversationSchema(db);
      const chats = await listChatThreads(db, { limit, cursor });
      return c.json({ chats });
    } finally {
      await db.close();
    }
  });

  app.get("/conversations/plans", validateQuery(plansQuerySchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const { limit, cursor } = c.req.valid("query");
    const db = await openDatabase(workspaceName);

    try {
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
        };
      });
      return c.json({ plans });
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
    } finally {
      await db.close();
    }
  });

  app.delete("/conversations/:threadId", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const threadId = c.req.param("threadId");
    const db = await openDatabase(workspaceName);

    try {
      await ensureConversationSchema(db);
      const thread = await getThreadById(db, threadId);
      if (!thread) {
        throw new PragmaError("THREAD_NOT_FOUND", 404, `Conversation thread not found: ${threadId}`);
      }
      if (thread.mode !== "plan") {
        throw new PragmaError("INVALID_OPERATION", 400, "Only plan threads can be deleted.");
      }
      await closeThread(db, threadId);
      return c.json({ ok: true });
    } finally {
      await db.close();
    }
  });

  app.post("/conversations/turns/stream", validateJson(conversationTurnSchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const body = c.req.valid("json");
    const modelId = resolveModelId(body.harness, body.model_label);
    const reasoningEffort = body.reasoning_effort;
    const db = await openDatabase(workspaceName);
    await ensureConversationSchema(db);
    const paths = getWorkspacePaths(workspaceName);
    const adapter = getConversationAdapter(body.harness);
    try {
      const requestedRecipientAgentId =
        body.mode === "plan" ? (body.recipient_agent_id ?? null) : null;
      if (requestedRecipientAgentId) {
        const recipient = await getAgentRow(db, requestedRecipientAgentId);
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

      if (thread.harness !== body.harness) {
        throw new PragmaError(
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
        const planPromptCandidates =
          body.mode === "plan" ? await listPlanWorkerCandidates(db) : [];
        const workspaceIsEmpty =
          body.mode === "plan" ? await isDirectoryEmpty(paths.codeDir) : false;
        const prompt = buildPrompt(body.mode, message, reasoningEffort, pragmaCliCommand, {
          planCandidates: planPromptCandidates.map((candidate) => ({
            id: candidate.id,
            name: candidate.name,
            description: candidate.description,
            harness: candidate.harness,
            modelLabel: candidate.model_label,
          })),
          workspaceIsEmpty,
        });

        const result = await adapter.sendTurn({
          prompt,
          modelId,
          sessionId: thread.harness_session_id,
          cwd: paths.codeDir,
          env: buildConversationAgentEnv({
            apiUrl,
            pragmaCliCommand,
            workspaceName,
            threadId,
            turnId,
            agentId: DEFAULT_AGENT_ID,
            taskId: thread.task_id,
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
        const selectedPlanRecipientAgentId =
          body.mode === "plan" ? await getStoredPlanRecipientForTurn(db, turnId) : null;
        const planRecipientSelectionCount =
          body.mode === "plan" ? await countPlanRecipientSelectionsForTurn(db, turnId) : 0;
        if (
          body.mode === "plan" &&
          (!selectedPlanRecipientAgentId || planRecipientSelectionCount < 1)
        ) {
          throw new PragmaError(
            "PLAN_RECIPIENT_REQUIRED",
            409,
            "Plan mode requires at least one `pragma task plan-select-recipient` CLI submission.",
          );
        }

        await completeTurn(db, {
          turnId,
          assistantMessage: finalAssistantText,
          selectedAgentId: selectedPlanRecipientAgentId,
          selectionStatus: body.mode === "plan" ? "auto_selected" : null,
        });

        await insertMessage(db, {
          id: assistantMessageId,
          threadId,
          turnId,
          role: "assistant",
          content: finalAssistantText,
        });

        if (body.mode === "chat") {
          // Only generate a title on the first turn (when no title exists yet)
          const existing = await db.query<{ chat_title: string | null }>(
            `SELECT chat_title FROM conversation_threads WHERE id = $1 LIMIT 1`,
            [threadId],
          );
          const hasTitle = existing.rows[0]?.chat_title && existing.rows[0].chat_title !== "";

          if (!hasTitle) {
            // Set a quick placeholder from the user's message so the sidebar isn't blank
            const placeholder = deriveChatTitle(message, finalAssistantText);
            await updateChatThreadMetadata(db, {
              threadId,
              title: placeholder,
              lastMessageAt: new Date().toISOString(),
            });

            // Fire AI title generation and overwrite the placeholder when ready
            generateTitle(db, message, finalAssistantText).then((aiTitle) => {
              updateChatThreadMetadata(db, {
                threadId,
                title: aiTitle,
                lastMessageAt: new Date().toISOString(),
                force: true,
              }).catch(() => {});
            }).catch(() => {});
          } else {
            await updateChatThreadMetadata(db, {
              threadId,
              lastMessageAt: new Date().toISOString(),
            });
          }
        }

        await updateThreadSession(db, {
          threadId,
          sessionId: result.sessionId,
        });

        const turnCompletedPayload = {
          turn_id: turnId,
          assistant_message_id: assistantMessageId,
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

  app.post("/conversations/:threadId/execute", validateJson(executeFromThreadSchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const threadId = c.req.param("threadId");
    const body = c.req.valid("json");
    const reasoningEffort = body.reasoning_effort;
    const db = await openDatabase(workspaceName);
    let taskId =`task_${randomUUID().slice(0, 8)}`;
    let executeThreadId = `thread_${randomUUID().slice(0, 12)}`;
    let executePrompt = "";
    let requestedRecipientAgentId: string | null = null;

    try {
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
      const planTitle = truncateChatText(
        latestPlanTurn.user_message?.replace(/\s+/g, " ").trim() || "Task",
        80,
      );
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
          "Plan is missing a selected recipient. Submit `pragma task plan-select-recipient` in plan mode.",
        );
      }
      const executeRecipient = await getAgentRow(db, requestedRecipientAgentId);
      if (!executeRecipient || executeRecipient.id === DEFAULT_AGENT_ID) {
        throw new PragmaError(
          "INVALID_RECIPIENT",
          400,
          `Invalid recipient agent id: ${requestedRecipientAgentId}`,
        );
      }

      executePrompt = planText;

      await db.query(
        `
INSERT INTO tasks (id, title, status, assigned_to, output_dir, session_id, plan)
VALUES ($1, $2, 'queued', $3, NULL, NULL, $4)
`,
        [taskId, planTitle, executeRecipient.id, planText],
      );
      emitTaskStatus(workspaceName, taskId, "queued", "execute_from_plan_created");

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
    } finally {
      await db.close();
    }

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
    const workspaceName = await requireActiveWorkspaceName();
    const paths = getWorkspacePaths(workspaceName);
    const folders = await listCodeFolders(paths.codeDir);
    return c.json({ folders });
  });

  app.post("/code/repos/clone", validateJson(createCodeRepoCloneSchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
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
    const workspaceName = await requireActiveWorkspaceName();
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
    return c.json({ ok: true, folder: { name: folderName }, folders }, 201);
  });

  app.post("/code/folders/import", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
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
    const workspaceName = await requireActiveWorkspaceName();
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

  app.get("/context", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const paths = getWorkspacePaths(workspaceName);

    const context = await listContext(paths.contextDir);
    return c.json({ context });
  });

  app.post("/context/folders", validateJson(createContextFolderSchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
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
    const workspaceName = await requireActiveWorkspaceName();
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
    const workspaceName = await requireActiveWorkspaceName();
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

  // ── Skill Registry (GitHub) ──────────────────────────────────────

  interface GitHubTreeItem {
    path: string;
    mode: string;
    type: string;
    sha: string;
    url: string;
  }

  interface RegistrySkill {
    name: string;
    description: string;
    provider: string;
    repo: string;
    skill_path: string;
  }

  async function fetchGitHubTree(owner: string, repo: string, treeSha: string): Promise<GitHubTreeItem[]> {
    const url = `https://api.github.com/repos/${owner}/${repo}/git/trees/${treeSha}`;
    const res = await fetch(url, {
      headers: { Accept: "application/vnd.github+json", "User-Agent": "pragma" },
    });
    if (!res.ok) return [];
    const data = (await res.json()) as { tree?: GitHubTreeItem[] };
    return Array.isArray(data.tree) ? data.tree : [];
  }

  async function fetchGitHubFileContent(owner: string, repo: string, path: string): Promise<string> {
    const url = `https://raw.githubusercontent.com/${owner}/${repo}/main/${path}`;
    const res = await fetch(url, { headers: { "User-Agent": "pragma" } });
    if (!res.ok) throw new PragmaError("FETCH_FAILED", 502, `Failed to fetch ${path} from ${owner}/${repo}`);
    return res.text();
  }

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

  async function fetchRegistrySkills(): Promise<RegistrySkill[]> {
    const results: RegistrySkill[] = [];

    // 1. Anthropic: skills/
    const anthropicTree = await fetchGitHubTree("anthropics", "skills", "main");
    // The top-level tree may include "skills" folder
    const anthropicSkillsEntry = anthropicTree.find((e) => e.path === "skills" && e.type === "tree");
    if (anthropicSkillsEntry) {
      const skillDirs = await fetchGitHubTree("anthropics", "skills", anthropicSkillsEntry.sha);
      const dirs = skillDirs.filter((e) => e.type === "tree");
      const settled = await Promise.allSettled(
        dirs.map(async (dir) => {
          let desc = "";
          try {
            const content = await fetchGitHubFileContent("anthropics", "skills", `skills/${dir.path}/SKILL.md`);
            desc = parseSkillMdDescription(content);
          } catch {}
          return {
            name: dir.path,
            description: desc,
            provider: "anthropic",
            repo: "anthropics/skills",
            skill_path: `skills/${dir.path}`,
          };
        }),
      );
      for (const r of settled) {
        if (r.status === "fulfilled") results.push(r.value);
      }
    }

    // 2. OpenAI: skills/.curated/
    const openaiTree = await fetchGitHubTree("openai", "skills", "main");
    const openaiSkillsEntry = openaiTree.find((e) => e.path === "skills" && e.type === "tree");
    if (openaiSkillsEntry) {
      const skillsSubtree = await fetchGitHubTree("openai", "skills", openaiSkillsEntry.sha);
      const curatedEntry = skillsSubtree.find((e) => e.path === ".curated" && e.type === "tree");
      if (curatedEntry) {
        const curatedDirs = await fetchGitHubTree("openai", "skills", curatedEntry.sha);
        const dirs = curatedDirs.filter((e) => e.type === "tree");
        const settled = await Promise.allSettled(
          dirs.map(async (dir) => {
            let desc = "";
            try {
              const content = await fetchGitHubFileContent("openai", "skills", `skills/.curated/${dir.path}/SKILL.md`);
              desc = parseSkillMdDescription(content);
            } catch {}
            return {
              name: dir.path,
              description: desc,
              provider: "openai",
              repo: "openai/skills",
              skill_path: `skills/.curated/${dir.path}`,
            };
          }),
        );
        for (const r of settled) {
          if (r.status === "fulfilled") results.push(r.value);
        }
      }
    }

    return results;
  }

  app.get("/skills/registry", async (c) => {
    try {
      const skills = await fetchRegistrySkills();
      return c.json({ skills });
    } catch (error: unknown) {
      throw new PragmaError("REGISTRY_FETCH_FAILED", 502, errorMessage(error));
    }
  });

  app.post("/skills/registry/install", validateJson(
    z.object({
      name: z.string().trim().min(1),
      provider: z.string().trim().min(1),
      repo: z.string().trim().min(1),
      skill_path: z.string().trim().min(1),
    }).strict()
  ), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const body = c.req.valid("json");

    // Fetch the SKILL.md content from GitHub
    const [owner, repo] = body.repo.split("/");
    const skillMdContent = await fetchGitHubFileContent(owner, repo, `${body.skill_path}/SKILL.md`);
    const description = parseSkillMdDescription(skillMdContent);

    const db = await openDatabase(workspaceName);
    try {
      const skillId = `skill_${randomUUID().slice(0, 12)}`;
      await db.query(
        `INSERT INTO skills (id, name, description, content) VALUES ($1, $2, $3, $4)`,
        [skillId, body.name, description, skillMdContent],
      );

      return c.json({ ok: true, id: skillId }, 201);
    } catch (error: unknown) {
      const message = errorMessage(error);
      if (message.includes("unique") || message.includes("duplicate")) {
        throw new PragmaError("SKILL_NAME_EXISTS", 409, `Skill "${body.name}" is already installed.`);
      }
      throw new PragmaError("INSTALL_SKILL_FAILED", 400, message);
    } finally {
      await db.close();
    }
  });

  // ── Skills CRUD ────────────────────────────────────────────────────

  app.get("/skills", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const db = await openDatabase(workspaceName);

    try {
      const result = await db.query<{
        id: string;
        name: string;
        description: string | null;
      }>(`SELECT id, name, description FROM skills ORDER BY name ASC`);

      return c.json({ skills: result.rows });
    } finally {
      await db.close();
    }
  });

  app.post("/skills", validateJson(createSkillSchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const body = c.req.valid("json");

    const db = await openDatabase(workspaceName);
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
    } finally {
      await db.close();
    }
  });

  app.put("/skills/:id", validateJson(updateSkillSchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const id = c.req.param("id");
    const body = c.req.valid("json");

    const db = await openDatabase(workspaceName);
    try {
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
    } finally {
      await db.close();
    }
  });

  app.delete("/skills/:id", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const id = c.req.param("id");

    const db = await openDatabase(workspaceName);
    try {
      const result = await db.query(`DELETE FROM skills WHERE id = $1`, [id]);
      if ((result.affectedRows ?? 0) === 0) {
        throw new PragmaError("SKILL_NOT_FOUND", 404, `Skill not found: ${id}`);
      }

      return c.json({ ok: true });
    } finally {
      await db.close();
    }
  });

  // ── Agent-Skill Assignments ────────────────────────────────────────

  app.get("/agents/:id/skills", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const agentId = c.req.param("id");

    const db = await openDatabase(workspaceName);
    try {
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
    } finally {
      await db.close();
    }
  });

  app.post("/agents/:id/skills", validateJson(assignAgentSkillSchema), async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const agentId = c.req.param("id");
    const body = c.req.valid("json");

    const db = await openDatabase(workspaceName);
    try {
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
    } finally {
      await db.close();
    }
  });

  app.delete("/agents/:id/skills/:skillId", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const agentId = c.req.param("id");
    const skillId = c.req.param("skillId");

    const db = await openDatabase(workspaceName);
    try {
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
    } finally {
      await db.close();
    }
  });

  app.get("/agents/:id/skills/:skillId/content", async (c) => {
    const workspaceName = await requireActiveWorkspaceName();
    const agentId = c.req.param("id");
    const skillId = c.req.param("skillId");

    const db = await openDatabase(workspaceName);
    try {
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
    } finally {
      await db.close();
    }
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
    server.close();
    void closeOpenDatabases().finally(() => {
      process.exit(0);
    });
  };

  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
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

async function listPlanWorkerCandidates(
  db: Awaited<ReturnType<typeof openDatabase>>,
): Promise<Array<{
  id: string;
  name: string;
  description: string | null;
  harness: HarnessId;
  model_label: string;
}>> {
  const result = await db.query<{
    id: string;
    name: string;
    description: string | null;
    harness: HarnessId;
    model_label: string;
  }>(
    `
SELECT id, name, description, harness, model_label
FROM agents
WHERE id <> $1
ORDER BY name ASC
`,
    [DEFAULT_AGENT_ID],
  );
  return result.rows;
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

async function getStoredPlanRecipientForTurn(
  db: Awaited<ReturnType<typeof openDatabase>>,
  turnId: string,
): Promise<string | null> {
  const result = await db.query<{ selected_agent_id: string | null }>(
    `
SELECT selected_agent_id
FROM conversation_turns
WHERE id = $1
LIMIT 1
`,
    [turnId],
  );
  return result.rows[0]?.selected_agent_id ?? null;
}

async function countPlanRecipientSelectionsForTurn(
  db: Awaited<ReturnType<typeof openDatabase>>,
  turnId: string,
): Promise<number> {
  const result = await db.query<{ count: number }>(
    `
SELECT COUNT(*)::int AS count
FROM conversation_events
WHERE turn_id = $1
  AND event_name = 'plan_recipient_selected'
`,
    [turnId],
  );
  return result.rows[0]?.count ?? 0;
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
    throw new PragmaError("TASK_OUTPUT_DIR_MISSING", 409, `Task output directory is missing: ${taskId}`);
  }

  const absolute = resolve(storedOutputDir.trim());
  if (!isWithinRoot(mainRoot, absolute) && !isWithinRoot(worktreeRoot, absolute)) {
    throw new PragmaError("TASK_OUTPUT_DIR_INVALID", 409, `Task output directory is invalid: ${taskId}`);
  }
  if (!(await isDirectory(absolute))) {
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

async function requireActiveWorkspaceName(): Promise<string> {
  const activeWorkspace = await getActiveWorkspaceName();
  if (!activeWorkspace) {
    throw new PragmaError(
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
