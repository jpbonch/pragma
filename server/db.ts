import { mkdir, readdir, readFile, rm, stat, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { PGLiteSocketServer } from "@electric-sql/pglite-socket";
import { Client } from "pg";
import { initializeWorkspaceGit } from "./conversation/gitWorkflow";
import { ensureConversationSchema } from "./conversation/store";
import { BUNDLED_SKILLS } from "./bundledSkills";

export const PRAGMA_DIR = join(homedir(), ".pragma");
const ACTIVE_WORKSPACE_FILE = join(PRAGMA_DIR, "active_workspace");
const RESERVED_ROOT_NAMES = new Set(["db", "workspace", "worktrees"]);
export const DEFAULT_AGENT_ID = "pragma-orchestrator";
export const SCRIBE_AGENT_ID = "pragma-scribe";
const OPEN_DATABASES = new Map<string, Promise<PGlite>>();

const DEFAULT_HARNESS_MODELS: Record<string, { label: string; id: string }> = {
  claude_code: { label: "Opus 4.6", id: "opus" },
  codex: { label: "GPT-5", id: "gpt-5" },
};

function getDefaultModelForHarness(harness: string): { label: string; id: string } {
  return DEFAULT_HARNESS_MODELS[harness] ?? DEFAULT_HARNESS_MODELS.claude_code;
}
const REAL_CLOSE = new WeakMap<object, () => Promise<void>>();
const DB_SOCKET_HOST = "127.0.0.1";
const DB_SOCKET_WAIT_MS = 5000;
const DB_SOCKET_POLL_MS = 100;

type DbSocketInfo = {
  workspaceName: string;
  host: string;
  port: number;
  ownerPid: number;
  startedAt: string;
};

type DbOwnerLock = {
  ownerPid: number;
  createdAt: string;
};

export const DEFAULT_AGENT_FILE = `# Orchestrator

You are the Orchestrator agent for Pragma.

Your only job is to pick the single best worker agent for each incoming task. You do NOT execute the task yourself.

## Rules
- You MUST call exactly one CLI command per turn: \`select-recipient\`.
- The \`--agent-id\` MUST be one of the listed candidate ids.
- The \`--reason\` must be one sentence.
- Do not output JSON tags or any RECIPIENT payload.
- If no candidate is a perfect fit, still choose the closest match.
- After the command succeeds, return a concise plain-text confirmation.

## select-recipient command
\`\`\`
pragma-so task select-recipient --agent-id <candidate_id> --reason "<one sentence reason>"
\`\`\`
`;

const CODER_AGENT_FILE = `# Coder

You are the implementation specialist.

Your task is to:
- Turn requirements into working code.
- Make focused, minimal diffs.
- Run builds/tests and fix failures before handoff.
- Report what changed and any follow-up work.

## Testing

The workspace has a testing app at \`testing/\` — a Vite+React shell that the reviewer uses to interact with your work.

**Your job is to keep the app runnable, not to write tests.**

- When you set up or change how services start (new server, different port, different start command), update \`testing/config.json\` to reflect the current services.
- Each service in config.json has a \`type\`: use \`"ui"\` for web apps (shown in an iframe), \`"api"\` for API servers (shown in a built-in API explorer), \`"background"\` for supporting services like databases.
- Make sure \`command\`, \`cwd\`, and \`url\` are correct so the reviewer can start services and interact with them from the Testing pane.
- If the testing app's dev server is not running, start it: \`cd testing && npm run dev\`

**Do NOT** submit testing config JSON. Do NOT write test component files for every feature. Just keep \`testing/config.json\` accurate and the app running. The reviewer will test by using the actual app.
`;

const SCRIBE_AGENT_FILE = `# Scribe

You are the Scribe agent. After every completed task, you review what happened and extract **enduring project knowledge** into the workspace's \`context/\` folder.

## What to extract

- **Decisions & constraints** — Choices made (or discovered) during the task that would affect how future work is approached. Why something is done a certain way, especially when the reason isn't obvious.
- **Process & conventions** — Unwritten rules, preferred workflows, naming schemes, formatting standards, or stakeholder preferences that aren't captured in any existing documentation.
- **Dependencies & relationships** — People, teams, tools, services, accounts, data sources, or external systems involved — and how they connect. Who owns what. What breaks if something changes.
- **Gotchas & edge cases** — Non-obvious pitfalls, exceptions to general rules, things that almost went wrong, counterintuitive behaviors, or common misunderstandings.
- **Key facts & definitions** — Domain-specific terminology, metrics, thresholds, or reference data that an agent would need to do related work correctly.

## What NOT to extract

- What the task accomplished (the task record already captures that).
- Information that's obvious from reading the relevant files or documents.
- General domain knowledge an LLM would already know.
- Vague observations ("the project is complex", "stakeholders were helpful").
- Temporary state that will be stale within days (unless it's a deadline).

## Output

- Create or update markdown files in the \`context/\` directory.
- Use descriptive filenames (e.g. \`context/deployment-setup.md\`, \`context/auth-conventions.md\`).
- Keep each file focused on one topic. Merge into existing files when the topic already exists.
- If there is nothing meaningful to extract, report that and do not create files.

Return a concise final result listing which context files were created or updated, or state that no updates were needed.
`;

const UI_DESIGNER_AGENT_FILE = `# UI Designer

You are **UI Designer**, an expert user interface designer who creates beautiful, consistent, and accessible user interfaces. You specialize in visual design systems, component libraries, and pixel-perfect interface creation that enhances user experience while reflecting brand identity.

## Your Core Mission

### Create Comprehensive Design Systems
- Develop component libraries with consistent visual language and interaction patterns
- Design scalable design token systems for cross-platform consistency
- Establish visual hierarchy through typography, color, and layout principles
- Build responsive design frameworks that work across all device types
- **Default requirement**: Include accessibility compliance (WCAG AA minimum) in all designs

### Craft Pixel-Perfect Interfaces
- Design detailed interface components with precise specifications
- Create interactive prototypes that demonstrate user flows and micro-interactions
- Develop dark mode and theming systems for flexible brand expression
- Ensure brand integration while maintaining optimal usability

### Enable Developer Success
- Provide clear design handoff specifications with measurements and assets
- Create comprehensive component documentation with usage guidelines
- Establish design QA processes for implementation accuracy validation
- Build reusable pattern libraries that reduce development time

## Critical Rules

### Design System First Approach
- Establish component foundations before creating individual screens
- Design for scalability and consistency across entire product ecosystem
- Create reusable patterns that prevent design debt and inconsistency
- Build accessibility into the foundation rather than adding it later

### Performance-Conscious Design
- Optimize images, icons, and assets for web performance
- Design with CSS efficiency in mind to reduce render time
- Consider loading states and progressive enhancement in all designs
- Balance visual richness with technical constraints

## Your Workflow Process

1. **Design System Foundation**: Review brand guidelines, analyze UI patterns, research accessibility requirements
2. **Component Architecture**: Design base components (buttons, inputs, cards, navigation), create variations and states, establish interaction patterns
3. **Visual Hierarchy System**: Develop typography scale, design color system with semantic meaning, create spacing system, establish shadow and elevation system
4. **Developer Handoff**: Generate detailed design specifications, create component documentation, prepare optimized assets, establish design QA process

## Communication Style

- **Be precise**: Specify exact values, ratios, and measurements
- **Focus on consistency**: Establish and follow systematic design tokens
- **Think systematically**: Create component variations that scale across all breakpoints
- **Ensure accessibility**: Design with keyboard navigation and screen reader support (WCAG AA: 4.5:1 contrast for normal text, 3:1 for large text)

## Testing

The workspace has a testing app at \`testing/\` — a Vite+React shell that the reviewer uses to interact with your work.

**Your job is to keep the app runnable, not to write tests.**

- When you set up or change how services start (new server, different port, different start command), update \`testing/config.json\` to reflect the current services.
- Each service in config.json has a \`type\`: use \`"ui"\` for web apps (shown in an iframe), \`"api"\` for API servers (shown in a built-in API explorer), \`"background"\` for supporting services like databases.
- Make sure \`command\`, \`cwd\`, and \`url\` are correct so the reviewer can start services and interact with them from the Testing pane.
- If the testing app's dev server is not running, start it: \`cd testing && npm run dev\`

**Do NOT** submit testing config JSON. Do NOT write test component files for every feature. Just keep \`testing/config.json\` accurate and the app running. The reviewer will test by using the actual app.
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
  {
    id: "pragma-ui-designer",
    name: "UI Designer",
    description: "Creates beautiful, consistent, and accessible user interfaces with design systems and pixel-perfect components.",
    status: "idle",
    agent_file: UI_DESIGNER_AGENT_FILE,
    emoji: "🎨",
    harness: "claude_code",
    model_label: "Opus 4.6",
    model_id: "opus",
  },
  {
    id: SCRIBE_AGENT_ID,
    name: "Scribe",
    description: "Reviews completed tasks and updates the context folder with enduring project knowledge.",
    status: "idle",
    agent_file: SCRIBE_AGENT_FILE,
    emoji: "📝",
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

/**
 * Query a single row by ID and throw a PragmaError(404) if it doesn't exist.
 */
export async function findOrThrow<T extends Record<string, unknown>>(
  db: PGlite,
  table: string,
  id: string,
  errorCode: string,
  label: string = table.replace(/_/g, " "),
  columns: string = "id",
): Promise<T> {
  const result = await db.query<T>(`SELECT ${columns} FROM ${table} WHERE id = $1 LIMIT 1`, [id]);
  if (result.rows.length === 0) {
    throw new PragmaError(errorCode, 404, `${label} not found: ${id}`);
  }
  return result.rows[0];
}

/**
 * Delete a row by ID and throw a PragmaError(404) if no row was affected.
 */
export async function deleteOrThrow(
  db: PGlite,
  table: string,
  id: string,
  errorCode: string,
  label: string = table.replace(/_/g, " "),
): Promise<void> {
  const result = await db.query(`DELETE FROM ${table} WHERE id = $1`, [id]);
  if ((result.affectedRows ?? 0) === 0) {
    throw new PragmaError(errorCode, 404, `${label} not found: ${id}`);
  }
}

/**
 * Run an UPDATE and throw a PragmaError(404) if no row was affected.
 */
export async function updateOrThrow(
  db: PGlite,
  sql: string,
  params: unknown[],
  errorCode: string,
  label: string,
  id: string,
): Promise<void> {
  const result = await db.query(sql, params);
  if ((result.affectedRows ?? 0) === 0) {
    throw new PragmaError(errorCode, 404, `${label} not found: ${id}`);
  }
}

/**
 * Delete a junction-table row by two composite-key columns and throw 404 if not found.
 */
export async function deleteJunctionOrThrow(
  db: PGlite,
  table: string,
  col1: string,
  val1: string,
  col2: string,
  val2: string,
  errorCode: string,
  message: string,
): Promise<void> {
  const result = await db.query(
    `DELETE FROM ${table} WHERE ${col1} = $1 AND ${col2} = $2`,
    [val1, val2],
  );
  if ((result.affectedRows ?? 0) === 0) {
    throw new PragmaError(errorCode, 404, message);
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
  testingDir: string;
  codeDir: string;
  outputsDir: string;
  uploadsDir: string;
  worktreesDir: string;
  binDir: string;
} {
  const rootDir = join(PRAGMA_DIR, name);
  const workspaceDir = join(rootDir, "workspace");
  const contextDir = join(workspaceDir, "context");
  const testingDir = join(workspaceDir, "testing");

  return {
    name,
    rootDir,
    dbDir: join(rootDir, "db"),
    workspaceDir,
    contextDir,
    testingDir,
    codeDir: join(workspaceDir, "code"),
    outputsDir: join(workspaceDir, "outputs"),
    uploadsDir: join(workspaceDir, "uploads"),
    worktreesDir: join(rootDir, "worktrees"),
    binDir: join(workspaceDir, "bin"),
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
  await mkdir(paths.testingDir, { recursive: true });

  await scaffoldTestingApp(paths.testingDir);
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
    await ensureDefaultAutomations(db);
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

  const pending = openWorkspaceDatabase(paths).catch((error) => {
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

async function openWorkspaceDatabase(
  paths: ReturnType<typeof getWorkspacePaths>,
): Promise<PGlite> {
  const remote = await tryConnectToWorkspaceDatabase(paths);
  if (remote) {
    return remote;
  }

  if (await acquireWorkspaceOwnerLock(paths)) {
    try {
      return await createOwnedWorkspaceDatabase(paths);
    } catch (error) {
      await cleanupWorkspaceSocketFiles(paths);
      throw error;
    }
  }

  const waited = await waitForWorkspaceDatabase(paths);
  if (waited) {
    return waited;
  }

  throw new Error(`Timed out waiting for shared workspace database: ${paths.name}`);
}

async function createOwnedWorkspaceDatabase(
  paths: ReturnType<typeof getWorkspacePaths>,
): Promise<PGlite> {
  const db = await initializeWorkspaceDatabase(paths.dbDir);
  const rawClose = db.close.bind(db);
  const socketServer = new PGLiteSocketServer({
    db,
    host: DB_SOCKET_HOST,
    port: 0,
    maxConnections: 25,
  });
  await socketServer.start();

  const socketInfo = createSocketInfo(paths.name, socketServer.getServerConn());
  await writeSocketInfo(paths, socketInfo);

  const realClose = async () => {
    await socketServer.stop().catch(() => {});
    await cleanupWorkspaceSocketFiles(paths);
    await rawClose();
  };

  return patchDatabaseClose(db, realClose);
}

async function initializeWorkspaceDatabase(dbDir: string): Promise<PGlite> {
  const db = new PGlite(dbDir);
  await db.waitReady;
  await ensureRequiredSchema(db);
  await ensureDefaultAgents(db);
  await ensureDefaultHuman(db);
  await ensureDefaultSkills(db);
  await ensureConversationSchema(db);
  await ensureDefaultAutomations(db);
  return db;
}

function patchDatabaseClose<T extends { close: () => Promise<void> }>(
  db: T,
  realClose: () => Promise<void>,
): T {
  if (REAL_CLOSE.has(db as object)) {
    return db;
  }

  REAL_CLOSE.set(db as object, realClose);
  db.close = async () => {};
  return db;
}

async function tryConnectToWorkspaceDatabase(
  paths: ReturnType<typeof getWorkspacePaths>,
): Promise<PGlite | null> {
  const socketInfo = await readSocketInfo(paths);
  if (!socketInfo) {
    return null;
  }

  try {
    return await connectToSharedDatabase(socketInfo);
  } catch {
    if (!isProcessAlive(socketInfo.ownerPid)) {
      await cleanupWorkspaceSocketFiles(paths);
    }
    return null;
  }
}

async function waitForWorkspaceDatabase(
  paths: ReturnType<typeof getWorkspacePaths>,
): Promise<PGlite | null> {
  const startedAt = Date.now();

  while (Date.now() - startedAt < DB_SOCKET_WAIT_MS) {
    const remote = await tryConnectToWorkspaceDatabase(paths);
    if (remote) {
      return remote;
    }

    const ownerLock = await readOwnerLock(paths);
    if (!ownerLock) {
      if (await acquireWorkspaceOwnerLock(paths)) {
        try {
          return await createOwnedWorkspaceDatabase(paths);
        } catch (error) {
          await cleanupWorkspaceSocketFiles(paths);
          throw error;
        }
      }
    } else if (!isProcessAlive(ownerLock.ownerPid)) {
      await cleanupWorkspaceSocketFiles(paths);
      if (await acquireWorkspaceOwnerLock(paths)) {
        try {
          return await createOwnedWorkspaceDatabase(paths);
        } catch (error) {
          await cleanupWorkspaceSocketFiles(paths);
          throw error;
        }
      }
    }

    await sleep(DB_SOCKET_POLL_MS);
  }

  return null;
}

async function connectToSharedDatabase(socketInfo: DbSocketInfo): Promise<PGlite> {
  const client = new Client({
    host: socketInfo.host,
    port: socketInfo.port,
    database: "template1",
    ssl: false,
  });
  client.on("error", () => {});
  await client.connect();
  await client.query("SELECT 1");

  const remote = patchDatabaseClose(
    new RemotePGliteClient(client),
    async () => {
      await client.end().catch(() => {});
    },
  );

  return remote as unknown as PGlite;
}

async function acquireWorkspaceOwnerLock(
  paths: ReturnType<typeof getWorkspacePaths>,
): Promise<boolean> {
  const lockPath = getSocketLockPath(paths);

  for (;;) {
    try {
      const payload: DbOwnerLock = {
        ownerPid: process.pid,
        createdAt: new Date().toISOString(),
      };
      await writeFile(lockPath, JSON.stringify(payload), { flag: "wx" });
      return true;
    } catch (error) {
      if (!isNodeError(error) || error.code !== "EEXIST") {
        throw error;
      }

      const lock = await readOwnerLock(paths);
      if (!lock || !isProcessAlive(lock.ownerPid)) {
        await rm(lockPath, { force: true });
        continue;
      }

      return false;
    }
  }
}

async function readSocketInfo(
  paths: ReturnType<typeof getWorkspacePaths>,
): Promise<DbSocketInfo | null> {
  try {
    const raw = await readFile(getSocketInfoPath(paths), "utf8");
    const parsed = JSON.parse(raw) as Partial<DbSocketInfo>;
    if (
      parsed.workspaceName !== paths.name ||
      typeof parsed.host !== "string" ||
      !Number.isInteger(parsed.port) ||
      parsed.port! <= 0 ||
      typeof parsed.ownerPid !== "number"
    ) {
      return null;
    }
    return {
      workspaceName: parsed.workspaceName,
      host: parsed.host,
      port: Number(parsed.port),
      ownerPid: parsed.ownerPid,
      startedAt: typeof parsed.startedAt === "string" ? parsed.startedAt : "",
    };
  } catch {
    return null;
  }
}

async function writeSocketInfo(
  paths: ReturnType<typeof getWorkspacePaths>,
  socketInfo: DbSocketInfo,
): Promise<void> {
  await writeFile(getSocketInfoPath(paths), JSON.stringify(socketInfo));
}

async function readOwnerLock(
  paths: ReturnType<typeof getWorkspacePaths>,
): Promise<DbOwnerLock | null> {
  try {
    const raw = await readFile(getSocketLockPath(paths), "utf8");
    const parsed = JSON.parse(raw) as Partial<DbOwnerLock>;
    if (typeof parsed.ownerPid !== "number") {
      return null;
    }
    return {
      ownerPid: parsed.ownerPid,
      createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
    };
  } catch {
    return null;
  }
}

async function cleanupWorkspaceSocketFiles(
  paths: ReturnType<typeof getWorkspacePaths>,
): Promise<void> {
  await rm(getSocketInfoPath(paths), { force: true });
  await rm(getSocketLockPath(paths), { force: true });
}

function getSocketInfoPath(paths: ReturnType<typeof getWorkspacePaths>): string {
  return join(paths.rootDir, ".db-socket.json");
}

function getSocketLockPath(paths: ReturnType<typeof getWorkspacePaths>): string {
  return join(paths.rootDir, ".db-socket.lock");
}

function createSocketInfo(workspaceName: string, serverConn: string): DbSocketInfo {
  const [host, portValue] = serverConn.split(":");
  const port = Number.parseInt(portValue ?? "", 10);
  if (!host || !Number.isInteger(port) || port <= 0) {
    throw new Error(`Invalid PGlite socket server address: ${serverConn}`);
  }

  return {
    workspaceName,
    host,
    port,
    ownerPid: process.pid,
    startedAt: new Date().toISOString(),
  };
}

function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }

  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isNodeError(error: unknown): error is NodeJS.ErrnoException {
  return typeof error === "object" && error !== null && "code" in error;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class RemotePGliteClient {
  constructor(private readonly client: Client) {}

  async query<T = Record<string, unknown>>(sql: string, params?: unknown[]) {
    const result = await this.client.query(sql, params as unknown[] | undefined);
    return {
      rows: result.rows as T[],
      fields: result.fields,
      rowCount: result.rowCount ?? 0,
      affectedRows: result.rowCount ?? 0,
    };
  }

  async exec(sql: string): Promise<void> {
    await this.client.query(sql);
  }

  async close(): Promise<void> {
    await this.client.end();
  }
}

async function scaffoldTestingApp(testingDir: string): Promise<void> {
  const srcDir = join(testingDir, "src");
  const componentsDir = join(srcDir, "components");
  await mkdir(componentsDir, { recursive: true });

  const pkgJson = {
    name: "pragma-testing",
    private: true,
    type: "module",
    scripts: {
      dev: "vite --host 127.0.0.1",
      build: "vite build",
    },
    dependencies: {
      react: "^19.0.0",
      "react-dom": "^19.0.0",
    },
    devDependencies: {
      "@types/react": "^19.0.0",
      "@types/react-dom": "^19.0.0",
      "@vitejs/plugin-react": "^4.3.0",
      typescript: "^5.6.0",
      vite: "^6.0.0",
    },
  };

  const viteConfig = `import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  plugins: [react()],
  server: { port: 5199 },
})
`;

  const tsConfig = `{
  "compilerOptions": {
    "target": "ES2020",
    "module": "ESNext",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
`;

  const indexHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Pragma Testing</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: #1a1a2e; color: #e0e0e0; }
  </style>
</head>
<body>
  <div id="root"></div>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>
`;

  const mainTsx = `import { createRoot } from "react-dom/client"
import App from "./App"

createRoot(document.getElementById("root")!).render(<App />)
`;

  const appTsx = `import { useState } from "react"
import config from "./config.json"
import ServiceBar from "./components/ServiceBar"
import AppFrame from "./components/AppFrame"
import ApiExplorer from "./components/ApiExplorer"

export default function App() {
  const interactiveServices = config.services.filter((s: any) => s.type !== "background")
  const [activeTab, setActiveTab] = useState(interactiveServices[0]?.name ?? "")

  const active = interactiveServices.find((s: any) => s.name === activeTab)

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100vh" }}>
      <ServiceBar services={config.services} />

      {interactiveServices.length > 1 && (
        <div style={{ display: "flex", gap: 0, borderBottom: "1px solid #333", background: "#1e1e2e" }}>
          {interactiveServices.map((s: any) => (
            <button
              key={s.name}
              onClick={() => setActiveTab(s.name)}
              style={{
                padding: "8px 16px",
                background: s.name === activeTab ? "#2a2a3e" : "transparent",
                color: s.name === activeTab ? "#fff" : "#888",
                border: "none",
                borderBottom: s.name === activeTab ? "2px solid #646cff" : "2px solid transparent",
                cursor: "pointer",
                fontSize: 13,
              }}
            >
              {s.name}
            </button>
          ))}
        </div>
      )}

      <div style={{ flex: 1, overflow: "hidden" }}>
        {active?.type === "ui" && <AppFrame url={active.url} />}
        {active?.type === "api" && <ApiExplorer baseUrl={active.url} />}
        {!active && <div style={{ padding: 24, color: "#666" }}>No interactive services configured.</div>}
      </div>
    </div>
  )
}
`;

  const configJson = JSON.stringify({ services: [] }, null, 2);

  const serviceBarTsx = `export default function ServiceBar({ services }: { services: any[] }) {
  return (
    <div style={{
      display: "flex",
      alignItems: "center",
      gap: 12,
      padding: "6px 12px",
      background: "#16162a",
      borderBottom: "1px solid #333",
      fontSize: 12,
    }}>
      <span style={{ fontWeight: 600, color: "#888" }}>Services</span>
      {services.map((s: any) => (
        <div key={s.name} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <span style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: s.type === "background" ? "#666" : "#4caf50",
          }} />
          <span style={{ color: "#ccc" }}>{s.name}</span>
          <span style={{ color: "#666" }}>({s.type})</span>
        </div>
      ))}
      {services.length === 0 && <span style={{ color: "#555" }}>No services — update config.json</span>}
    </div>
  )
}
`;

  const appFrameTsx = `import { useRef } from "react"

export default function AppFrame({ url }: { url: string }) {
  const ref = useRef<HTMLIFrameElement>(null)
  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      <div style={{ padding: "4px 8px", display: "flex", gap: 8, alignItems: "center", borderBottom: "1px solid #333", background: "#1e1e2e" }}>
        <button
          onClick={() => { if (ref.current) ref.current.src = ref.current.src }}
          style={{ padding: "2px 8px", background: "#333", color: "#ccc", border: "1px solid #444", borderRadius: 4, cursor: "pointer", fontSize: 12 }}
        >
          Refresh
        </button>
        <span style={{ opacity: 0.5, fontSize: 12 }}>{url}</span>
      </div>
      <iframe ref={ref} src={url} style={{ flex: 1, border: "none", width: "100%" }} />
    </div>
  )
}
`;

  const apiExplorerTsx = `import { useState } from "react"

type HistoryEntry = {
  method: string
  url: string
  status: number
  elapsed: number
  timestamp: number
}

export default function ApiExplorer({ baseUrl }: { baseUrl: string }) {
  const [method, setMethod] = useState("GET")
  const [path, setPath] = useState("/")
  const [headers, setHeaders] = useState("")
  const [body, setBody] = useState("")
  const [response, setResponse] = useState<{ status: number; headers: string; body: string; elapsed: number } | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState("")
  const [history, setHistory] = useState<HistoryEntry[]>(() => {
    try {
      return JSON.parse(localStorage.getItem("pragma-api-explorer-history") || "[]")
    } catch {
      return []
    }
  })

  async function send() {
    setLoading(true)
    setError("")
    setResponse(null)
    const url = baseUrl.replace(/\\/$/, "") + path
    const start = Date.now()
    try {
      const opts: RequestInit = { method }
      if (headers.trim()) {
        try { opts.headers = JSON.parse(headers) } catch { setError("Invalid headers JSON"); setLoading(false); return }
      }
      if (method !== "GET" && method !== "HEAD" && body.trim()) {
        opts.body = body
        if (!opts.headers) opts.headers = {}
        if (!(opts.headers as Record<string, string>)["content-type"]) {
          (opts.headers as Record<string, string>)["content-type"] = "application/json"
        }
      }
      const res = await fetch(url, opts)
      const elapsed = Date.now() - start
      const resBody = await res.text()
      const resHeaders = Array.from(res.headers.entries()).map(([k, v]) => k + ": " + v).join("\\n")
      setResponse({ status: res.status, headers: resHeaders, body: resBody, elapsed })
      const entry: HistoryEntry = { method, url, status: res.status, elapsed, timestamp: Date.now() }
      const updated = [entry, ...history].slice(0, 50)
      setHistory(updated)
      try { localStorage.setItem("pragma-api-explorer-history", JSON.stringify(updated)) } catch {}
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoading(false)
    }
  }

  let prettyBody = response?.body ?? ""
  try { prettyBody = JSON.stringify(JSON.parse(prettyBody), null, 2) } catch {}

  const inputStyle: React.CSSProperties = { padding: "6px 8px", background: "#1e1e2e", color: "#e0e0e0", border: "1px solid #333", borderRadius: 4, fontSize: 13, fontFamily: "monospace" }
  const labelStyle: React.CSSProperties = { fontSize: 11, color: "#888", marginBottom: 2 }

  return (
    <div style={{ display: "flex", height: "100%", overflow: "hidden" }}>
      <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8, padding: 12, overflow: "auto" }}>
        <div style={{ display: "flex", gap: 6 }}>
          <select value={method} onChange={e => setMethod(e.target.value)} style={{ ...inputStyle, width: 100 }}>
            {["GET", "POST", "PUT", "PATCH", "DELETE"].map(m => <option key={m}>{m}</option>)}
          </select>
          <input value={path} onChange={e => setPath(e.target.value)} placeholder="/path" style={{ ...inputStyle, flex: 1 }} />
          <button onClick={send} disabled={loading} style={{ padding: "6px 16px", background: "#646cff", color: "#fff", border: "none", borderRadius: 4, cursor: "pointer", fontSize: 13 }}>
            {loading ? "..." : "Send"}
          </button>
        </div>
        <div><div style={labelStyle}>Headers (JSON)</div><textarea value={headers} onChange={e => setHeaders(e.target.value)} rows={2} style={{ ...inputStyle, width: "100%", resize: "vertical" }} placeholder='{"Authorization": "Bearer ..."}' /></div>
        {method !== "GET" && method !== "HEAD" && (
          <div><div style={labelStyle}>Body</div><textarea value={body} onChange={e => setBody(e.target.value)} rows={4} style={{ ...inputStyle, width: "100%", resize: "vertical" }} placeholder='{"key": "value"}' /></div>
        )}
        {error && <div style={{ color: "#f44", fontSize: 13 }}>{error}</div>}
        {response && (
          <div style={{ display: "flex", flexDirection: "column", gap: 4, flex: 1, minHeight: 0 }}>
            <div style={{ display: "flex", gap: 12, fontSize: 13 }}>
              <span style={{ color: response.status < 400 ? "#4caf50" : "#f44" }}>Status: {response.status}</span>
              <span style={{ color: "#888" }}>{response.elapsed}ms</span>
            </div>
            <div style={labelStyle}>Response Headers</div>
            <pre style={{ ...inputStyle, whiteSpace: "pre-wrap", fontSize: 11, maxHeight: 80, overflow: "auto" }}>{response.headers}</pre>
            <div style={labelStyle}>Response Body</div>
            <pre style={{ ...inputStyle, whiteSpace: "pre-wrap", flex: 1, overflow: "auto" }}>{prettyBody}</pre>
          </div>
        )}
      </div>
      <div style={{ width: 200, borderLeft: "1px solid #333", overflow: "auto", padding: 8, fontSize: 11 }}>
        <div style={{ fontWeight: 600, color: "#888", marginBottom: 4 }}>History</div>
        {history.map((h, i) => (
          <div key={i} onClick={() => { setMethod(h.method); setPath(new URL(h.url).pathname) }}
            style={{ padding: "4px 6px", cursor: "pointer", borderBottom: "1px solid #222", color: "#aaa" }}>
            <span style={{ color: h.status < 400 ? "#4caf50" : "#f44" }}>{h.status}</span> {h.method} {new URL(h.url).pathname}
          </div>
        ))}
        {history.length === 0 && <div style={{ color: "#555" }}>No history</div>}
      </div>
    </div>
  )
}
`;

  await writeFile(join(testingDir, "package.json"), JSON.stringify(pkgJson, null, 2) + "\n");
  await writeFile(join(testingDir, "vite.config.ts"), viteConfig);
  await writeFile(join(testingDir, "tsconfig.json"), tsConfig);
  await writeFile(join(testingDir, "index.html"), indexHtml);
  await writeFile(join(srcDir, "main.tsx"), mainTsx);
  await writeFile(join(srcDir, "App.tsx"), appTsx);
  await writeFile(join(srcDir, "config.json"), configJson);
  await writeFile(join(componentsDir, "ServiceBar.tsx"), serviceBarTsx);
  await writeFile(join(componentsDir, "AppFrame.tsx"), appFrameTsx);
  await writeFile(join(componentsDir, "ApiExplorer.tsx"), apiExplorerTsx);
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
ALTER TABLE tasks
ADD COLUMN IF NOT EXISTS changes_diff TEXT
`);

  await db.exec(`
ALTER TABLE tasks
DROP COLUMN IF EXISTS testing_config_json
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
  display_name VARCHAR(255),
  description TEXT,
  content TEXT NOT NULL,
  provider VARCHAR(64) NOT NULL DEFAULT '',
  binary_name VARCHAR(64) NOT NULL DEFAULT '',
  env_var VARCHAR(128) NOT NULL DEFAULT '',
  auth_type VARCHAR(32) NOT NULL DEFAULT 'oauth2',
  oauth_client_id TEXT,
  oauth_client_secret TEXT,
  oauth_auth_url TEXT NOT NULL DEFAULT '',
  oauth_token_url TEXT NOT NULL DEFAULT '',
  scopes TEXT NOT NULL DEFAULT '',
  redirect_uri TEXT NOT NULL DEFAULT 'http://127.0.0.1:3000/connectors/callback',
  status VARCHAR(32) NOT NULL DEFAULT 'disconnected',
  access_token TEXT,
  refresh_token TEXT,
  token_expires_at TIMESTAMPTZ,
  is_custom BOOLEAN NOT NULL DEFAULT false
);
`);

  await db.exec(`
CREATE TABLE IF NOT EXISTS agent_connectors (
  agent_id VARCHAR(64) REFERENCES agents(id) ON DELETE CASCADE,
  connector_id VARCHAR(64) REFERENCES connectors(id) ON DELETE CASCADE,
  PRIMARY KEY (agent_id, connector_id)
);
`);


  await db.exec(`
CREATE TABLE IF NOT EXISTS pragma_events (
  id VARCHAR(64) PRIMARY KEY,
  seq SERIAL,
  event_type VARCHAR(128) NOT NULL,
  task_id VARCHAR(64),
  thread_id VARCHAR(64),
  turn_id VARCHAR(64),
  workspace_name VARCHAR(128),
  payload_json TEXT NOT NULL,
  source VARCHAR(128) NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_pragma_events_type ON pragma_events(event_type, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pragma_events_task ON pragma_events(task_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_pragma_events_seq ON pragma_events(seq ASC);
`);

  await db.exec(`
CREATE TABLE IF NOT EXISTS workspace_automations (
  id VARCHAR(64) PRIMARY KEY,
  name TEXT NOT NULL,
  trigger_event_type VARCHAR(128) NOT NULL,
  trigger_filter_json TEXT,
  action_type VARCHAR(32) NOT NULL,
  action_config_json TEXT NOT NULL,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
`);

  // Add schedule columns to workspace_automations
  await db.exec(`
ALTER TABLE workspace_automations
ADD COLUMN IF NOT EXISTS trigger_type VARCHAR(16) NOT NULL DEFAULT 'event'
`);
  await db.exec(`
ALTER TABLE workspace_automations
ADD COLUMN IF NOT EXISTS schedule_cron VARCHAR(128)
`);
  await db.exec(`
ALTER TABLE workspace_automations
ADD COLUMN IF NOT EXISTS schedule_timezone VARCHAR(64) NOT NULL DEFAULT 'UTC'
`);
  await db.exec(`
ALTER TABLE workspace_automations
ADD COLUMN IF NOT EXISTS last_scheduled_at TIMESTAMPTZ
`);

  await db.exec(`
CREATE TABLE IF NOT EXISTS automation_runs (
  id VARCHAR(64) PRIMARY KEY,
  automation_id VARCHAR(64) NOT NULL REFERENCES workspace_automations(id) ON DELETE CASCADE,
  event_id VARCHAR(64),
  status VARCHAR(16) NOT NULL,
  result_json TEXT,
  executed_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_automation_runs_automation ON automation_runs(automation_id, executed_at DESC);
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

async function ensureDefaultSkills(db: PGlite): Promise<void> {
  for (const skill of BUNDLED_SKILLS) {
    await db.query(
      `INSERT INTO skills (id, name, description, content)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [skill.id, skill.name, skill.description, skill.content],
    );
  }

}

const DEFAULT_SCRIBE_AUTOMATION_ID = "auto_scribe_on_complete";

async function ensureDefaultAutomations(db: PGlite): Promise<void> {
  await db.query(
    `INSERT INTO workspace_automations
       (id, name, trigger_event_type, trigger_filter_json, trigger_type, action_type, action_config_json, enabled)
     VALUES ($1, $2, $3, $4, 'event', $5, $6, true)
     ON CONFLICT (id) DO NOTHING`,
    [
      DEFAULT_SCRIBE_AUTOMATION_ID,
      "Scribe: update context after task completion",
      "task.completed",
      JSON.stringify({ assigned_to: { $ne: SCRIBE_AGENT_ID } }),
      "execute_task",
      JSON.stringify({
        prompt: "A task was just completed (task ID: {{event.taskId}}). Review what happened in that task — look at its changes, conversations, and outcomes — then update the context/ folder with any enduring project knowledge worth preserving. If there is nothing meaningful to extract, say so and do not create files.",
        recipientAgentId: SCRIBE_AGENT_ID,
      }),
    ],
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
