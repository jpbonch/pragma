import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { initializeWorkspaceGit } from "./conversation/gitWorkflow";
import { ensureConversationSchema } from "./conversation/store";

export const PRAGMA_DIR = join(homedir(), ".pragma");
const ACTIVE_WORKSPACE_FILE = join(PRAGMA_DIR, "active_workspace");
const RESERVED_ROOT_NAMES = new Set(["db", "workspace", "worktrees"]);
export const DEFAULT_AGENT_ID = "pragma-orchestrator";
const OPEN_DATABASES = new Map<string, Promise<PGlite>>();

const DEFAULT_HARNESS_MODELS: Record<string, { label: string; id: string }> = {
  claude_code: { label: "Opus 4.6", id: "opus" },
  codex: { label: "GPT-5", id: "gpt-5" },
};

function getDefaultModelForHarness(harness: string): { label: string; id: string } {
  return DEFAULT_HARNESS_MODELS[harness] ?? DEFAULT_HARNESS_MODELS.claude_code;
}
const REAL_CLOSE = new WeakMap<PGlite, () => Promise<void>>();

export const DEFAULT_AGENT_FILE = `# Orchestrator

You are the orchestrator agent for Pragma.

Your task is to:
- Plan tasks into clear, ordered steps.
- Spawn specialized agents to execute those steps.
- Coordinate progress across agents.
- Track status, risks, and blockers.
- Produce concise updates and a final combined result.

## Pragma Commands
- \`pragma setup\`: Calls the API setup endpoint. This only bootstraps \`~/.pragma\`.
- \`pragma create-task <title> [--status <status>] [--assigned-to <agent_id>] [--output-dir <path>]\`: Calls the API to create a row in the \`tasks\` table. Default status is \`queued\`.
- \`pragma list-tasks [--status <status>] [--limit <n>]\`: Calls the API to list tasks from newest to oldest.
- \`pragma task select-recipient --agent-id <id> --reason "<text>"\`: Persist orchestrator recipient selection.
- \`pragma task plan-select-recipient --agent-id <id> --reason "<text>"\`: Persist recipient selection for the current plan turn.
- \`pragma task ask-question --question "<text>" [--details "<text>"]\`: Ask the human a blocking question.
- \`pragma task request-help --summary "<text>" [--details "<text>"]\`: Escalate for human help.
- \`pragma db-query --sql "<SELECT statement>"\`: Run a read-only SQL query against the workspace database. Key tables: tasks, agents, conversation_threads, conversation_turns, conversation_messages, conversation_events.
- \`pragma server [--port <n>]\`: Starts the Pragma API server.
- \`pragma ui [--port <n>] [--api-url <url>]\`: Starts the Pragma UI.
- \`pragma\` (no args): Starts server + UI and opens the UI.
`;

const CODER_AGENT_FILE = `# Coder

You are the implementation specialist.

Your task is to:
- Turn requirements into working code.
- Make focused, minimal diffs.
- Run builds/tests and fix failures before handoff.
- Report what changed and any follow-up work.
`;

type DefaultAgentSeed = {
  id: string;
  name: string;
  description: string;
  status: string;
  agent_file: string;
  emoji: string;
  harness: string;
  model_label: string;
  model_id: string;
};

const DEFAULT_AGENT_SEEDS: DefaultAgentSeed[] = [
  {
    id: DEFAULT_AGENT_ID,
    name: "Orchestrator",
    description: "Plans tasks, spawns specialized agents, and coordinates progress across the team.",
    status: "active",
    agent_file: DEFAULT_AGENT_FILE,
    emoji: "🧭",
    harness: "claude_code",
    model_label: "Opus 4.6",
    model_id: "opus",
  },
  {
    id: "pragma-coder",
    name: "Coder",
    description: "Turns requirements into working code with focused, minimal diffs.",
    status: "idle",
    agent_file: CODER_AGENT_FILE,
    emoji: "💻",
    harness: "claude_code",
    model_label: "Opus 4.6",
    model_id: "opus",
  },
];

export class PragmaError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function getPragmaRoot(): string {
  return PRAGMA_DIR;
}

export function getWorkspacePaths(name: string): {
  name: string;
  rootDir: string;
  dbDir: string;
  workspaceDir: string;
  contextDir: string;
  codeDir: string;
  outputsDir: string;
  uploadsDir: string;
  worktreesDir: string;
} {
  const rootDir = join(PRAGMA_DIR, name);
  const workspaceDir = join(rootDir, "workspace");
  const contextDir = join(workspaceDir, "context");

  return {
    name,
    rootDir,
    dbDir: join(rootDir, "db"),
    workspaceDir,
    contextDir,
    codeDir: join(workspaceDir, "code"),
    outputsDir: join(workspaceDir, "outputs"),
    uploadsDir: join(workspaceDir, "uploads"),
    worktreesDir: join(rootDir, "worktrees"),
  };
}

export async function setupPragma(): Promise<void> {
  await mkdir(PRAGMA_DIR, { recursive: true });
}

export async function listWorkspaceNames(): Promise<string[]> {
  await setupPragma();

  const entries = await readdir(PRAGMA_DIR, { withFileTypes: true });
  return entries
    .filter((entry) => {
      if (!entry.isDirectory()) {
        return false;
      }
      if (entry.name.startsWith(".")) {
        return false;
      }
      if (RESERVED_ROOT_NAMES.has(entry.name)) {
        return false;
      }
      return true;
    })
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

export async function getActiveWorkspaceName(): Promise<string | null> {
  await setupPragma();

  let storedName = "";
  try {
    storedName = (await readFile(ACTIVE_WORKSPACE_FILE, "utf8")).trim();
  } catch {
    return null;
  }

  if (!storedName) {
    return null;
  }

  try {
    validateWorkspaceName(storedName);
  } catch {
    return null;
  }

  if (!(await workspaceExists(storedName))) {
    return null;
  }

  return storedName;
}

export async function setActiveWorkspaceName(name: string): Promise<void> {
  validateWorkspaceName(name);

  if (!(await workspaceExists(name))) {
    throw new PragmaError(
      "WORKSPACE_NOT_FOUND",
      404,
      `Workspace does not exist: ${name}`,
    );
  }

  await setupPragma();
  await writeFile(ACTIVE_WORKSPACE_FILE, name, "utf8");
}

export async function createWorkspace(input: {
  name: string;
  orchestrator_harness: string;
}): Promise<void> {
  const name = input.name;
  const orchestratorHarness = input.orchestrator_harness;

  validateWorkspaceName(name);

  await setupPragma();

  const paths = getWorkspacePaths(name);
  if (await pathExists(paths.rootDir)) {
    throw new PragmaError(
      "WORKSPACE_EXISTS",
      409,
      `Workspace already exists: ${name}`,
    );
  }

  await mkdir(paths.dbDir, { recursive: true });
  await mkdir(paths.contextDir, { recursive: true });
  await mkdir(paths.codeDir, { recursive: true });
  await mkdir(paths.outputsDir, { recursive: true });
  await mkdir(paths.uploadsDir, { recursive: true });
  await mkdir(paths.worktreesDir, { recursive: true });

  await initializeDatabase(name, orchestratorHarness);
  await initializeWorkspaceGit(paths);

  await setActiveWorkspaceName(name);
}

export async function deleteWorkspace(name: string): Promise<{ nextActive: string | null }> {
  validateWorkspaceName(name);

  const paths = getWorkspacePaths(name);
  if (!(await pathExists(paths.rootDir))) {
    throw new PragmaError("WORKSPACE_NOT_FOUND", 404, `Workspace does not exist: ${name}`);
  }

  const currentActive = await getActiveWorkspaceName();
  await rm(paths.rootDir, { recursive: true, force: false });

  if (currentActive !== name) {
    return { nextActive: currentActive };
  }

  const remaining = await listWorkspaceNames();
  if (remaining.length === 0) {
    await clearActiveWorkspaceName();
    return { nextActive: null };
  }

  const nextActive = remaining[0];
  await writeFile(ACTIVE_WORKSPACE_FILE, nextActive, "utf8");
  return { nextActive };
}

export async function workspaceExists(name: string): Promise<boolean> {
  validateWorkspaceName(name);

  const paths = getWorkspacePaths(name);
  try {
    const entryStat = await stat(paths.rootDir);
    return entryStat.isDirectory();
  } catch {
    return false;
  }
}

export async function initializeDatabase(workspaceName: string, orchestratorHarness?: string): Promise<void> {
  const db = await openDatabase(workspaceName);

  try {
    await ensureRequiredSchema(db);
    await ensureDefaultAgents(db, orchestratorHarness);
    await ensureDefaultHuman(db);
    await ensureConversationSchema(db);
  } finally {
    await db.close();
  }
}

export async function openDatabase(workspaceName: string): Promise<PGlite> {
  validateWorkspaceName(workspaceName);

  const paths = getWorkspacePaths(workspaceName);
  await setupPragma();
  await mkdir(paths.dbDir, { recursive: true });

  const existing = OPEN_DATABASES.get(workspaceName);
  if (existing) {
    return existing;
  }

  const pending = createWorkspaceDatabase(paths.dbDir).catch((error) => {
    OPEN_DATABASES.delete(workspaceName);
    throw error;
  });

  OPEN_DATABASES.set(workspaceName, pending);
  return pending;
}

export async function closeOpenDatabases(): Promise<void> {
  const settled = await Promise.allSettled([...OPEN_DATABASES.values()]);
  OPEN_DATABASES.clear();

  await Promise.allSettled(
    settled
      .filter((entry): entry is PromiseFulfilledResult<PGlite> => entry.status === "fulfilled")
      .map(async (entry) => {
        const close = REAL_CLOSE.get(entry.value);
        if (close) {
          await close();
        }
      }),
  );
}

export function parseLimit(limitValue: string): number {
  const parsed = Number.parseInt(limitValue, 10);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid --limit value: ${limitValue}. Use a positive integer.`);
  }
  return parsed;
}

export function validateWorkspaceName(name: string): void {
  if (typeof name !== "string") {
    throw new PragmaError("INVALID_WORKSPACE_NAME", 400, "Workspace name must be a string.");
  }

  if (name.trim().length === 0) {
    throw new PragmaError("INVALID_WORKSPACE_NAME", 400, "Workspace name is required.");
  }

  if (name.includes("\0") || name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new PragmaError(
      "INVALID_WORKSPACE_NAME",
      400,
      "Workspace name cannot contain '/', '\\', '..', or NUL.",
    );
  }

  if (name === "active_workspace" || RESERVED_ROOT_NAMES.has(name)) {
    throw new PragmaError(
      "INVALID_WORKSPACE_NAME",
      400,
      "Workspace name is reserved.",
    );
  }
}

async function createWorkspaceDatabase(dbDir: string): Promise<PGlite> {
  const db = new PGlite(dbDir);
  await db.waitReady;
  await ensureRequiredSchema(db);
  await ensureDefaultAgents(db);
  await ensureDefaultHuman(db);
  await ensureConversationSchema(db);
  return patchDatabaseClose(db);
}

function patchDatabaseClose(db: PGlite): PGlite {
  if (REAL_CLOSE.has(db)) {
    return db;
  }

  const realClose = db.close.bind(db);
  REAL_CLOSE.set(db, realClose);
  db.close = async () => {};
  return db;
}

async function ensureRequiredSchema(db: PGlite): Promise<void> {
  await ensureTaskStatusEnumType(db);

  await db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  status VARCHAR(32) NOT NULL DEFAULT 'idle',
  agent_file TEXT,
  emoji VARCHAR(32),
  harness VARCHAR(32) NOT NULL DEFAULT 'claude_code',
  model_label VARCHAR(128) NOT NULL DEFAULT 'Opus 4.6',
  model_id VARCHAR(128) NOT NULL DEFAULT 'opus'
);
`);

  await db.exec(`
ALTER TABLE agents
ADD COLUMN IF NOT EXISTS description TEXT
`);

  await db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id VARCHAR(64) PRIMARY KEY,
  title TEXT NOT NULL,
  status task_status NOT NULL DEFAULT 'queued',
  assigned_to VARCHAR(64),
  output_dir TEXT,
  session_id VARCHAR(255),
  git_branch_name VARCHAR(255),
  git_state_json TEXT,
  test_commands_json TEXT,
  merge_retry_count INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ,
  FOREIGN KEY (assigned_to) REFERENCES agents(id)
);
`);
  const statusColumn = await db.query<{ udt_name: string }>(
    `
SELECT udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'tasks'
  AND column_name = 'status'
LIMIT 1
`,
  );

  const statusType = statusColumn.rows[0]?.udt_name ?? "";
  if (statusType && statusType !== "task_status") {
    await db.exec(`
ALTER TABLE tasks
ALTER COLUMN status TYPE task_status
USING status::task_status
`);
  }

  await db.exec(`
ALTER TABLE tasks
ALTER COLUMN status SET DEFAULT 'queued'
`);

  await db.exec(`
ALTER TABLE tasks
ALTER COLUMN status SET NOT NULL
`);

  await db.exec(`
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS git_branch_name VARCHAR(255)
`);

  await db.exec(`
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS git_state_json TEXT
`);

  await db.exec(`
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS test_commands_json TEXT
`);

  await db.exec(`
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS merge_retry_count INTEGER NOT NULL DEFAULT 0
`);

  await db.exec(`
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS completed_at TIMESTAMPTZ
`);

  await db.exec(`
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS plan TEXT
`);

  await db.exec(`
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS followup_task_id VARCHAR(64)
`);

  await db.exec(`
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS predecessor_task_id VARCHAR(64)
`);

  await db.exec(`
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS push_after_merge BOOLEAN NOT NULL DEFAULT FALSE
`);

  await db.exec(`
CREATE TABLE IF NOT EXISTS humans (
  id VARCHAR(64) PRIMARY KEY DEFAULT gen_random_uuid()::VARCHAR(64),
  emoji VARCHAR(32) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

  await db.exec(`
CREATE TABLE IF NOT EXISTS skills (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  content TEXT NOT NULL
);
`);

  await db.exec(`
CREATE TABLE IF NOT EXISTS agent_skills (
  agent_id VARCHAR(64) REFERENCES agents(id) ON DELETE CASCADE,
  skill_id VARCHAR(64) REFERENCES skills(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, skill_id)
);
`);

  await db.exec(`
CREATE TABLE IF NOT EXISTS connectors (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) UNIQUE NOT NULL,
  description TEXT,
  content TEXT NOT NULL,
  provider VARCHAR(64) NOT NULL,
  binary_name VARCHAR(64) NOT NULL,
  env_var VARCHAR(128) NOT NULL,
  auth_type VARCHAR(32) NOT NULL DEFAULT 'oauth2',
  oauth_client_id TEXT,
  oauth_client_secret TEXT,
  oauth_auth_url TEXT NOT NULL,
  oauth_token_url TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT '',
  redirect_uri TEXT NOT NULL DEFAULT 'http://127.0.0.1:3000/connectors/callback',
  status VARCHAR(32) NOT NULL DEFAULT 'disconnected',
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ
);
`);

  await db.exec(`
CREATE TABLE IF NOT EXISTS agent_connectors (
  agent_id VARCHAR(64) REFERENCES agents(id) ON DELETE CASCADE,
  connector_id VARCHAR(64) REFERENCES connectors(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, connector_id)
);
`);
}

async function ensureTaskStatusEnumType(db: PGlite): Promise<void> {
  const statusType = await db.query<{ exists: boolean }>(
    `
SELECT EXISTS (
  SELECT 1
  FROM pg_type t
  JOIN pg_namespace n ON n.oid = t.typnamespace
  WHERE t.typname = 'task_status'
    AND n.nspname = 'public'
) AS exists
`,
  );
  if (!statusType.rows[0]?.exists) {
    await db.exec(`
CREATE TYPE task_status AS ENUM (
  'queued',
  'orchestrating',
  'running',
  'waiting_for_recipient',
  'waiting_for_question_response',
  'waiting_for_help_response',
  'pending_review',
  'needs_fix',
  'completed',
  'failed',
  'cancelled'
);
`);
  }

  await db.exec(`ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'planning'`);
  await db.exec(`ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'planned'`);
  await db.exec(`ALTER TYPE task_status ADD VALUE IF NOT EXISTS 'merging'`);
}

async function ensureDefaultAgents(db: PGlite, orchestratorHarness?: string): Promise<void> {
  const seeds = orchestratorHarness
    ? DEFAULT_AGENT_SEEDS.map((seed) => {
        const harness = orchestratorHarness;
        const defaultModel = getDefaultModelForHarness(harness);
        return {
          ...seed,
          harness,
          model_label: defaultModel.label,
          model_id: defaultModel.id,
        };
      })
    : DEFAULT_AGENT_SEEDS;

  const orchestrator = seeds[0];
  await db.query(
    `
INSERT INTO agents (id, name, description, status, agent_file, emoji, harness, model_label, model_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
    description = EXCLUDED.description,
    status = EXCLUDED.status,
    agent_file = EXCLUDED.agent_file,
    emoji = EXCLUDED.emoji,
    harness = EXCLUDED.harness,
    model_label = EXCLUDED.model_label,
    model_id = EXCLUDED.model_id
`,
    [
      orchestrator.id,
      orchestrator.name,
      orchestrator.description,
      orchestrator.status,
      orchestrator.agent_file,
      orchestrator.emoji,
      orchestrator.harness,
      orchestrator.model_label,
      orchestrator.model_id,
    ],
  );

  for (const agent of seeds.slice(1)) {
    await db.query(
      `
INSERT INTO agents (id, name, description, status, agent_file, emoji, harness, model_label, model_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
ON CONFLICT (id) DO NOTHING
`,
      [
        agent.id,
        agent.name,
        agent.description,
        agent.status,
        agent.agent_file,
        agent.emoji,
        agent.harness,
        agent.model_label,
        agent.model_id,
      ],
    );
  }
}

const DEFAULT_HUMAN_ID = "you";
const DEFAULT_HUMAN_EMOJI = "🌿";

async function ensureDefaultHuman(db: PGlite): Promise<void> {
  await db.query(
    `INSERT INTO humans (id, emoji) VALUES ($1, $2) ON CONFLICT (id) DO NOTHING`,
    [DEFAULT_HUMAN_ID, DEFAULT_HUMAN_EMOJI],
  );
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

export async function updateTaskTitle(
  db: PGlite,
  taskId: string,
  title: string,
): Promise<void> {
  await db.query(`UPDATE tasks SET title = $2 WHERE id = $1`, [taskId, title]);
}

async function clearActiveWorkspaceName(): Promise<void> {
  try {
    await unlink(ACTIVE_WORKSPACE_FILE);
  } catch {
    // No active workspace file to remove.
  }
}
