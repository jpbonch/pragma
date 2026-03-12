import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { ensureConversationSchema } from "./conversation/store";

export const SALMON_DIR = join(homedir(), ".salmon");
const ACTIVE_WORKSPACE_FILE = join(SALMON_DIR, "active_workspace");
const RESERVED_ROOT_NAMES = new Set(["db", "workspace", "worktrees"]);
export const DEFAULT_AGENT_ID = "salmon-orchestrator";
const OPEN_DATABASES = new Map<string, Promise<PGlite>>();
const REAL_CLOSE = new WeakMap<PGlite, () => Promise<void>>();

export const DEFAULT_AGENT_FILE = `# Orchestrator

You are the orchestrator agent for Salmon.

Your job is to:
- Plan jobs into clear, ordered steps.
- Spawn specialized agents to execute those steps.
- Coordinate progress across agents.
- Track status, risks, and blockers.
- Produce concise updates and a final combined result.

## Salmon Commands
- \`salmon setup\`: Calls the API setup endpoint. This only bootstraps \`~/.salmon\`.
- \`salmon create-job <title> [--status <status>] [--assigned-to <agent_id>] [--output-dir <path>]\`: Calls the API to create a row in the \`jobs\` table. Default status is \`queued\`.
- \`salmon list-jobs [--status <status>] [--limit <n>]\`: Calls the API to list jobs from newest to oldest.
- \`salmon job select-recipient --agent-id <id> --reason "<text>"\`: Persist orchestrator recipient selection.
- \`salmon job ask-question --question "<text>" [--details "<text>"]\`: Ask the human a blocking question.
- \`salmon job request-help --summary "<text>" [--details "<text>"]\`: Escalate for human help.
- \`salmon server [--port <n>]\`: Starts the Salmon API server.
- \`salmon ui [--port <n>] [--api-url <url>]\`: Starts the Salmon UI.
- \`salmon\` (no args): Starts server + UI and opens the UI.
`;

const CODER_AGENT_FILE = `# Coder

You are the implementation specialist.

Your job is to:
- Turn requirements into working code.
- Make focused, minimal diffs.
- Run builds/tests and fix failures before handoff.
- Report what changed and any follow-up work.
`;

const RESEARCHER_AGENT_FILE = `# Researcher

You are the investigation specialist.

Your job is to:
- Clarify requirements, constraints, and edge cases.
- Compare options with concrete tradeoffs.
- Identify risks early and propose mitigations.
- Hand off actionable findings for implementation.
`;

const REVIEWER_AGENT_FILE = `# Reviewer

You are the quality and safety specialist.

Your job is to:
- Review code for correctness, regressions, and risk.
- Check tests and identify coverage gaps.
- Flag security, reliability, and performance issues.
- Give concise, prioritized findings.
`;

type DefaultAgentSeed = {
  id: string;
  name: string;
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
    status: "active",
    agent_file: DEFAULT_AGENT_FILE,
    emoji: "🧭",
    harness: "claude_code",
    model_label: "Opus 4.6",
    model_id: "opus",
  },
  {
    id: "salmon-coder",
    name: "Coder",
    status: "idle",
    agent_file: CODER_AGENT_FILE,
    emoji: "💻",
    harness: "claude_code",
    model_label: "Opus 4.6",
    model_id: "opus",
  },
  {
    id: "salmon-researcher",
    name: "Researcher",
    status: "idle",
    agent_file: RESEARCHER_AGENT_FILE,
    emoji: "🔎",
    harness: "claude_code",
    model_label: "Opus 4.6",
    model_id: "opus",
  },
  {
    id: "salmon-reviewer",
    name: "Reviewer",
    status: "idle",
    agent_file: REVIEWER_AGENT_FILE,
    emoji: "🛡️",
    harness: "claude_code",
    model_label: "Opus 4.6",
    model_id: "opus",
  },
];

export class SalmonError extends Error {
  code: string;
  status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function getSalmonRoot(): string {
  return SALMON_DIR;
}

export function getWorkspacePaths(name: string): {
  name: string;
  rootDir: string;
  dbDir: string;
  workspaceDir: string;
  contextDir: string;
  codeDir: string;
  worktreesDir: string;
  goalFile: string;
} {
  const rootDir = join(SALMON_DIR, name);
  const workspaceDir = join(rootDir, "workspace");
  const contextDir = join(workspaceDir, "context");

  return {
    name,
    rootDir,
    dbDir: join(rootDir, "db"),
    workspaceDir,
    contextDir,
    codeDir: join(workspaceDir, "code"),
    worktreesDir: join(rootDir, "worktrees"),
    goalFile: join(contextDir, "goal.md"),
  };
}

export async function setupSalmon(): Promise<void> {
  await mkdir(SALMON_DIR, { recursive: true });
}

export async function listWorkspaceNames(): Promise<string[]> {
  await setupSalmon();

  const entries = await readdir(SALMON_DIR, { withFileTypes: true });
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
  await setupSalmon();

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
    throw new SalmonError(
      "WORKSPACE_NOT_FOUND",
      404,
      `Workspace does not exist: ${name}`,
    );
  }

  await setupSalmon();
  await writeFile(ACTIVE_WORKSPACE_FILE, name, "utf8");
}

export async function createWorkspace(input: {
  name: string;
  goal: string;
}): Promise<void> {
  const name = input.name;
  const goal = input.goal;

  validateWorkspaceName(name);
  if (typeof goal !== "string" || goal.trim().length === 0) {
    throw new SalmonError("INVALID_GOAL", 400, "Goal is required.");
  }

  await setupSalmon();

  const paths = getWorkspacePaths(name);
  if (await pathExists(paths.rootDir)) {
    throw new SalmonError(
      "WORKSPACE_EXISTS",
      409,
      `Workspace already exists: ${name}`,
    );
  }

  await mkdir(paths.dbDir, { recursive: true });
  await mkdir(paths.contextDir, { recursive: true });
  await mkdir(paths.codeDir, { recursive: true });
  await mkdir(paths.worktreesDir, { recursive: true });

  await initializeDatabase(name);

  const goalContent = `# Workspace Goal\n\n## Goal\n${goal}\n`;
  await writeFile(paths.goalFile, goalContent, "utf8");

  await setActiveWorkspaceName(name);
}

export async function deleteWorkspace(name: string): Promise<{ nextActive: string | null }> {
  validateWorkspaceName(name);

  const paths = getWorkspacePaths(name);
  if (!(await pathExists(paths.rootDir))) {
    throw new SalmonError("WORKSPACE_NOT_FOUND", 404, `Workspace does not exist: ${name}`);
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

export async function initializeDatabase(workspaceName: string): Promise<void> {
  const db = await openDatabase(workspaceName);

  try {
    await ensureRequiredSchema(db);
    await ensureDefaultAgents(db);
    await ensureConversationSchema(db);
  } finally {
    await db.close();
  }
}

export async function openDatabase(workspaceName: string): Promise<PGlite> {
  validateWorkspaceName(workspaceName);

  const paths = getWorkspacePaths(workspaceName);
  await setupSalmon();
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
    throw new SalmonError("INVALID_WORKSPACE_NAME", 400, "Workspace name must be a string.");
  }

  if (name.trim().length === 0) {
    throw new SalmonError("INVALID_WORKSPACE_NAME", 400, "Workspace name is required.");
  }

  if (name.includes("\0") || name.includes("/") || name.includes("\\") || name.includes("..")) {
    throw new SalmonError(
      "INVALID_WORKSPACE_NAME",
      400,
      "Workspace name cannot contain '/', '\\', '..', or NUL.",
    );
  }

  if (name === "active_workspace" || RESERVED_ROOT_NAMES.has(name)) {
    throw new SalmonError(
      "INVALID_WORKSPACE_NAME",
      400,
      "Workspace name is reserved.",
    );
  }
}

function isPGliteAbortError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("Aborted(). Build with -sASSERTIONS");
}

async function createWorkspaceDatabase(dbDir: string): Promise<PGlite> {
  try {
    const db = new PGlite(dbDir);
    await db.waitReady;
    await ensureRequiredSchema(db);
    await ensureDefaultAgents(db);
    await ensureConversationSchema(db);
    return patchDatabaseClose(db);
  } catch (error: unknown) {
    if (!isPGliteAbortError(error)) {
      throw error;
    }

    // Hard self-heal path: this workspace DB is corrupted. Reset and rebuild schema.
    await rm(dbDir, { recursive: true, force: true });
    await mkdir(dbDir, { recursive: true });

    const db = new PGlite(dbDir);
    await db.waitReady;
    await ensureRequiredSchema(db);
    await ensureDefaultAgents(db);
    await ensureConversationSchema(db);
    return patchDatabaseClose(db);
  }
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
  await ensureJobStatusEnumType(db);

  await db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id VARCHAR(64) PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'idle',
  agent_file TEXT,
  emoji VARCHAR(32),
  harness VARCHAR(32) NOT NULL DEFAULT 'claude_code',
  model_label VARCHAR(128) NOT NULL DEFAULT 'Opus 4.6',
  model_id VARCHAR(128) NOT NULL DEFAULT 'opus'
);
`);

  await db.exec(`
CREATE TABLE IF NOT EXISTS jobs (
  id VARCHAR(64) PRIMARY KEY,
  title TEXT NOT NULL,
  status job_status NOT NULL DEFAULT 'queued',
  assigned_to VARCHAR(64),
  output_dir TEXT,
  session_id VARCHAR(255),
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (assigned_to) REFERENCES agents(id)
);
`);
  const statusColumn = await db.query<{ udt_name: string }>(
    `
SELECT udt_name
FROM information_schema.columns
WHERE table_schema = 'public'
  AND table_name = 'jobs'
  AND column_name = 'status'
LIMIT 1
`,
  );

  const statusType = statusColumn.rows[0]?.udt_name ?? "";
  if (statusType && statusType !== "job_status") {
    await db.exec(`
ALTER TABLE jobs
ALTER COLUMN status TYPE job_status
USING status::job_status
`);
  }

  await db.exec(`
ALTER TABLE jobs
ALTER COLUMN status SET DEFAULT 'queued'
`);

  await db.exec(`
ALTER TABLE jobs
ALTER COLUMN status SET NOT NULL
`);
}

async function ensureJobStatusEnumType(db: PGlite): Promise<void> {
  await db.exec(`
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_type
    WHERE typname = 'job_status'
  ) THEN
    CREATE TYPE job_status AS ENUM (
      'queued',
      'orchestrating',
      'running',
      'waiting_for_recipient',
      'waiting_for_question_response',
      'waiting_for_help_response',
      'pending_review',
      'needs_fix',
      'completed',
      'failed'
    );
  END IF;
END
$$;
`);
}

async function ensureDefaultAgents(db: PGlite): Promise<void> {
  const orchestrator = DEFAULT_AGENT_SEEDS[0];
  await db.query(
    `
INSERT INTO agents (id, name, status, agent_file, emoji, harness, model_label, model_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (id) DO UPDATE
SET name = EXCLUDED.name,
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
      orchestrator.status,
      orchestrator.agent_file,
      orchestrator.emoji,
      orchestrator.harness,
      orchestrator.model_label,
      orchestrator.model_id,
    ],
  );

  for (const agent of DEFAULT_AGENT_SEEDS.slice(1)) {
    await db.query(
      `
INSERT INTO agents (id, name, status, agent_file, emoji, harness, model_label, model_id)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
ON CONFLICT (id) DO NOTHING
`,
      [
        agent.id,
        agent.name,
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function clearActiveWorkspaceName(): Promise<void> {
  try {
    await unlink(ACTIVE_WORKSPACE_FILE);
  } catch {
    // No active workspace file to remove.
  }
}
