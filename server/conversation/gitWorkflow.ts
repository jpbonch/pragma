import {
  copyFile,
  cp,
  lstat,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { runCommand } from "../process/runCommand";

export type WorkspacePathsLike = {
  workspaceDir: string;
  codeDir: string;
  outputsDir: string;
  worktreesDir: string;
  contextDir: string;
};

export type TaskGitRepoState = {
  relative_path: string;
  base_branch: string;
  base_commit: string;
};

export type TaskGitState = {
  version: 1;
  branch_name: string;
  repos: TaskGitRepoState[];
};

export type PrepareTaskWorkspaceResult = {
  taskRootDir: string;
  taskWorkspaceDir: string;
  outputDir: string;
  gitState: TaskGitState;
};

export type MergeConflict = {
  repo_path: string;
  files: string[];
  message: string;
};

export type MergeTaskResult = {
  mergedRepos: string[];
  conflicts: MergeConflict[];
};

export type RepoDiffEntry = {
  repo_path: string;
  base_commit: string;
  head_commit: string;
  commit_diff: string;
  staged_diff: string;
  working_diff: string;
  diff: string;
  has_changes: boolean;
  error: string;
};

export async function initializeWorkspaceGit(paths: WorkspacePathsLike): Promise<void> {
  await mkdir(paths.workspaceDir, { recursive: true });
  await mkdir(paths.codeDir, { recursive: true });
  await mkdir(paths.outputsDir, { recursive: true });

  await ensureGitRepo(paths.workspaceDir);
  await ensureRootGitIgnore(paths.workspaceDir);
  await ensureDefaultCodeRepo(paths.codeDir);
  await commitIfNeeded(paths.workspaceDir, "pragma: initialize workspace repo");
}

export function getTaskWorktreeOutputDir(paths: WorkspacePathsLike, taskId: string): string {
  return join(paths.worktreesDir, taskId, "workspace", "outputs", taskId);
}

export function getTaskMainOutputDir(paths: WorkspacePathsLike, taskId: string): string {
  return join(paths.outputsDir, taskId);
}

export function parseTaskGitState(value: string | null | undefined): TaskGitState | null {
  if (!value || typeof value !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(value) as Partial<TaskGitState>;
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    if (parsed.version !== 1) {
      return null;
    }
    if (typeof parsed.branch_name !== "string" || parsed.branch_name.trim().length === 0) {
      return null;
    }
    if (!Array.isArray(parsed.repos) || parsed.repos.length === 0) {
      return null;
    }

    const repos: TaskGitRepoState[] = [];
    for (const repo of parsed.repos) {
      if (!repo || typeof repo !== "object") {
        return null;
      }
      const candidate = repo as Partial<TaskGitRepoState>;
      if (
        typeof candidate.relative_path !== "string" ||
        candidate.relative_path.trim().length === 0 ||
        typeof candidate.base_branch !== "string" ||
        candidate.base_branch.trim().length === 0 ||
        typeof candidate.base_commit !== "string" ||
        candidate.base_commit.trim().length === 0
      ) {
        return null;
      }
      repos.push({
        relative_path: normalizeRelativeRepoPath(candidate.relative_path),
        base_branch: candidate.base_branch.trim(),
        base_commit: candidate.base_commit.trim(),
      });
    }

    return {
      version: 1,
      branch_name: parsed.branch_name.trim(),
      repos,
    };
  } catch {
    return null;
  }
}

export function serializeTaskGitState(state: TaskGitState): string {
  return JSON.stringify(state);
}

export async function prepareTaskWorkspace(input: {
  workspacePaths: WorkspacePathsLike;
  taskId: string;
  existingState: TaskGitState | null;
  predecessorGitState?: TaskGitState | null;
}): Promise<PrepareTaskWorkspaceResult> {
  const taskRootDir = join(input.workspacePaths.worktreesDir, input.taskId);
  const taskWorkspaceDir = join(taskRootDir, "workspace");
  const outputDir = getTaskWorktreeOutputDir(input.workspacePaths, input.taskId);
  await mkdir(taskRootDir, { recursive: true });
  await mkdir(input.workspacePaths.outputsDir, { recursive: true });

  let gitState: TaskGitState;
  if (input.existingState) {
    gitState = await ensureExistingTaskWorktrees({
      workspacePaths: input.workspacePaths,
      taskWorkspaceDir,
      gitState: input.existingState,
    });
  } else if (input.predecessorGitState) {
    gitState = await createFollowupTaskWorktrees({
      workspacePaths: input.workspacePaths,
      taskId: input.taskId,
      taskWorkspaceDir,
      predecessorGitState: input.predecessorGitState,
    });
  } else {
    gitState = await createFreshTaskWorktrees({
      workspacePaths: input.workspacePaths,
      taskId: input.taskId,
      taskWorkspaceDir,
    });
  }

  const taskCodeDir = join(taskWorkspaceDir, "code");
  await mkdir(taskCodeDir, { recursive: true });
  await mkdir(join(taskWorkspaceDir, "outputs"), { recursive: true });
  await mkdir(join(taskWorkspaceDir, "context"), { recursive: true });
  await seedNonRepoCodeIntoTaskWorkspace({
    sourceCodeDir: input.workspacePaths.codeDir,
    targetCodeDir: taskCodeDir,
    managedCodeRepoPaths: gitState.repos.map((repo) => repo.relative_path),
  });
  await mkdir(outputDir, { recursive: true });

  return {
    taskRootDir,
    taskWorkspaceDir,
    outputDir,
    gitState,
  };
}

export async function checkpointTaskRepos(input: {
  workspacePaths: WorkspacePathsLike;
  taskId: string;
  gitState: TaskGitState;
  commitMessage: string;
}): Promise<void> {
  const taskWorkspaceDir = join(input.workspacePaths.worktreesDir, input.taskId, "workspace");

  for (const repo of input.gitState.repos) {
    const taskRepoPath = resolveRepoPath(taskWorkspaceDir, repo.relative_path);
    if (!(await isDirectory(taskRepoPath))) {
      continue;
    }

    await runGit(taskRepoPath, ["add", "-A"]);
    if (await hasStagedChanges(taskRepoPath)) {
      const sourceRepoPath = resolveRepoPath(input.workspacePaths.workspaceDir, repo.relative_path);
      const identity = await getUserGitIdentity(sourceRepoPath);
      await runGit(taskRepoPath, buildCommitArgs(identity, input.commitMessage));
    }
  }
}

export async function mergeApprovedTask(input: {
  workspacePaths: WorkspacePathsLike;
  taskId: string;
  taskTitle?: string;
  gitState: TaskGitState;
}): Promise<MergeTaskResult> {
  const taskWorkspaceDir = join(input.workspacePaths.worktreesDir, input.taskId, "workspace");
  const mergedRepos: string[] = [];
  const conflicts: MergeConflict[] = [];

  for (const repo of input.gitState.repos) {
    const sourceRepoPath = resolveRepoPath(input.workspacePaths.workspaceDir, repo.relative_path);
    const taskRepoPath = resolveRepoPath(taskWorkspaceDir, repo.relative_path);
    const label = input.taskTitle || input.taskId;
    const commitMessage = `pragma: ${label}`;

    try {
      await runGitSafe(sourceRepoPath, ["merge", "--abort"]);
      await runGit(sourceRepoPath, ["reset", "--hard", "HEAD"]);
      await runGit(sourceRepoPath, ["clean", "-fd"]);
      await runGit(sourceRepoPath, ["checkout", repo.base_branch]);
      await runGit(sourceRepoPath, ["reset", "--hard", "HEAD"]);
      await runGit(sourceRepoPath, ["clean", "-fd"]);

      await runGit(sourceRepoPath, [
        "merge",
        "--squash",
        "--no-commit",
        input.gitState.branch_name,
      ]);

      if (await hasStagedChanges(sourceRepoPath)) {
        const identity = await getUserGitIdentity(sourceRepoPath);
        await runGit(sourceRepoPath, buildCommitArgs(identity, commitMessage));
      }

      mergedRepos.push(repo.relative_path);
    } catch (error: unknown) {
      const message = errorMessage(error);
      const files = await listUnmergedFiles(sourceRepoPath);
      await runGitSafe(sourceRepoPath, ["merge", "--abort"]);
      await runGitSafe(sourceRepoPath, ["reset", "--hard", "HEAD"]);
      await runGitSafe(sourceRepoPath, ["clean", "-fd"]);
      await primeConflictInTaskRepo(taskRepoPath, repo.base_branch);
      conflicts.push({
        repo_path: repo.relative_path,
        files,
        message,
      });
    }
  }

  if (conflicts.length === 0) {
    for (const repo of input.gitState.repos) {
      const sourceRepoPath = resolveRepoPath(input.workspacePaths.workspaceDir, repo.relative_path);
      const taskRepoPath = resolveRepoPath(taskWorkspaceDir, repo.relative_path);
      await syncGitignoredFilesBackToSource({
        sourceRepoPath,
        worktreePath: taskRepoPath,
      });
    }

    await syncNonRepoCodeBackToWorkspace({
      sourceCodeDir: join(taskWorkspaceDir, "code"),
      targetCodeDir: input.workspacePaths.codeDir,
      managedCodeRepoPaths: input.gitState.repos.map((repo) => repo.relative_path),
    });
    await syncTaskOutputsBackToWorkspace({
      workspacePaths: input.workspacePaths,
      taskId: input.taskId,
    });
  }

  return { mergedRepos, conflicts };
}

export async function saveDiffSnapshot(input: {
  db: { query: (sql: string, params?: unknown[]) => Promise<unknown> };
  workspacePaths: WorkspacePathsLike;
  taskId: string;
  gitState: TaskGitState;
}): Promise<void> {
  const repoDiffs = await buildRepoDiffEntries(input);

  const combinedDiff = repoDiffs
    .filter((entry) => entry.diff.trim().length > 0)
    .map((entry) => {
      if (repoDiffs.length === 1) {
        return entry.diff;
      }
      return `# repo: ${entry.repo_path}\n${entry.diff}`;
    })
    .join("\n\n");

  await input.db.query(`UPDATE tasks SET changes_diff = $1 WHERE id = $2`, [combinedDiff, input.taskId]);
}

export async function deleteTaskWorktree(input: {
  workspacePaths: WorkspacePathsLike;
  taskId: string;
}): Promise<void> {
  const taskRootDir = join(input.workspacePaths.worktreesDir, input.taskId);
  await rm(taskRootDir, { recursive: true, force: true });
}

export async function buildRepoDiffEntries(input: {
  workspacePaths: WorkspacePathsLike;
  taskId: string;
  gitState: TaskGitState;
}): Promise<RepoDiffEntry[]> {
  const taskWorkspaceDir = join(input.workspacePaths.worktreesDir, input.taskId, "workspace");
  const entries: RepoDiffEntry[] = [];

  for (const repo of input.gitState.repos) {
    const taskRepoPath = resolveRepoPath(taskWorkspaceDir, repo.relative_path);
    try {
      const headCommit = (await runGitCapture(taskRepoPath, ["rev-parse", "HEAD"])).trim();
      const commitDiff = await runGitCapture(taskRepoPath, [
        "diff",
        `${repo.base_commit}..HEAD`,
        "--",
        ".",
      ]);

      entries.push({
        repo_path: repo.relative_path,
        base_commit: repo.base_commit,
        head_commit: headCommit,
        commit_diff: commitDiff,
        staged_diff: "",
        working_diff: "",
        diff: commitDiff,
        has_changes: commitDiff.trim().length > 0,
        error: "",
      });
    } catch (error: unknown) {
      entries.push({
        repo_path: repo.relative_path,
        base_commit: repo.base_commit,
        head_commit: "",
        commit_diff: "",
        staged_diff: "",
        working_diff: "",
        diff: "",
        has_changes: false,
        error: errorMessage(error),
      });
    }
  }

  return entries;
}

export function resolveRepoPath(rootPath: string, relativeRepoPath: string): string {
  if (relativeRepoPath === ".") {
    return rootPath;
  }
  return join(rootPath, relativeRepoPath);
}

async function createFreshTaskWorktrees(input: {
  workspacePaths: WorkspacePathsLike;
  taskId: string;
  taskWorkspaceDir: string;
}): Promise<TaskGitState> {
  const branchName = `pragma/task/${input.taskId}`;
  const relativeRepoPaths = await discoverFlatRepoPaths(input.workspacePaths);
  const repos: TaskGitRepoState[] = [];

  for (const relativePath of relativeRepoPaths) {
    const sourceRepoPath = resolveRepoPath(input.workspacePaths.workspaceDir, relativePath);
    const taskRepoPath = resolveRepoPath(input.taskWorkspaceDir, relativePath);
    const baseBranch = await getCurrentBranch(sourceRepoPath);
    if (!baseBranch || baseBranch === "HEAD") {
      throw new Error(`Repository is in detached HEAD and cannot be used: ${relativePath}`);
    }
    const baseCommit = (await runGitCapture(sourceRepoPath, ["rev-parse", "HEAD"])).trim();

    await ensureWorktree({
      sourceRepoPath,
      worktreePath: taskRepoPath,
      branchName,
      startPoint: baseCommit,
    });

    await symlinkOrCopyGitignoredFiles({ sourceRepoPath, worktreePath: taskRepoPath });

    repos.push({
      relative_path: relativePath,
      base_branch: baseBranch,
      base_commit: baseCommit,
    });
  }

  return {
    version: 1,
    branch_name: branchName,
    repos,
  };
}

async function createFollowupTaskWorktrees(input: {
  workspacePaths: WorkspacePathsLike;
  taskId: string;
  taskWorkspaceDir: string;
  predecessorGitState: TaskGitState;
}): Promise<TaskGitState> {
  const branchName = `pragma/task/${input.taskId}`;
  const repos: TaskGitRepoState[] = [];

  for (const predRepo of input.predecessorGitState.repos) {
    const relativePath = normalizeRelativeRepoPath(predRepo.relative_path);
    const sourceRepoPath = resolveRepoPath(input.workspacePaths.workspaceDir, relativePath);
    const taskRepoPath = resolveRepoPath(input.taskWorkspaceDir, relativePath);

    // Get the predecessor branch's current HEAD commit as start point
    const predecessorHead = (
      await runGitCapture(sourceRepoPath, ["rev-parse", input.predecessorGitState.branch_name])
    ).trim();

    await ensureWorktree({
      sourceRepoPath,
      worktreePath: taskRepoPath,
      branchName,
      startPoint: predecessorHead,
    });

    await symlinkOrCopyGitignoredFiles({ sourceRepoPath, worktreePath: taskRepoPath });

    repos.push({
      relative_path: relativePath,
      // base_branch stays the same as predecessor's (e.g., main) for final merge
      base_branch: predRepo.base_branch,
      // base_commit is the predecessor's HEAD so diffs show only the follow-up's changes
      base_commit: predecessorHead,
    });
  }

  return {
    version: 1,
    branch_name: branchName,
    repos,
  };
}

async function ensureExistingTaskWorktrees(input: {
  workspacePaths: WorkspacePathsLike;
  taskWorkspaceDir: string;
  gitState: TaskGitState;
}): Promise<TaskGitState> {
  const repos: TaskGitRepoState[] = [];
  for (const repo of input.gitState.repos) {
    const relativePath = normalizeRelativeRepoPath(repo.relative_path);
    const sourceRepoPath = resolveRepoPath(input.workspacePaths.workspaceDir, relativePath);
    const taskRepoPath = resolveRepoPath(input.taskWorkspaceDir, relativePath);
    await ensureWorktree({
      sourceRepoPath,
      worktreePath: taskRepoPath,
      branchName: input.gitState.branch_name,
      startPoint: repo.base_commit,
    });

    await symlinkOrCopyGitignoredFiles({ sourceRepoPath, worktreePath: taskRepoPath });

    repos.push({
      relative_path: relativePath,
      base_branch: repo.base_branch,
      base_commit: repo.base_commit,
    });
  }

  return {
    version: 1,
    branch_name: input.gitState.branch_name,
    repos,
  };
}

async function ensureWorktree(input: {
  sourceRepoPath: string;
  worktreePath: string;
  branchName: string;
  startPoint: string;
}): Promise<void> {
  if (await hasGitMarker(input.worktreePath)) {
    return;
  }

  await mkdir(dirname(input.worktreePath), { recursive: true });
  await runGit(input.sourceRepoPath, ["worktree", "prune"]);
  const branchExists = await gitBranchExists(input.sourceRepoPath, input.branchName);
  const args = branchExists
    ? ["worktree", "add", "--force", input.worktreePath, input.branchName]
    : ["worktree", "add", "--force", "-b", input.branchName, input.worktreePath, input.startPoint];
  await runGit(input.sourceRepoPath, args);
}

async function getTopLevelGitignoredEntries(repoPath: string): Promise<string[]> {
  let output: string;
  try {
    output = await runGitCapture(repoPath, [
      "ls-files",
      "--others",
      "--ignored",
      "--exclude-standard",
      "--directory",
    ]);
  } catch {
    return [];
  }

  const seen = new Set<string>();
  const entries: string[] = [];
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Extract top-level segment only (e.g. "node_modules/" from "node_modules/foo/bar")
    const firstSlash = trimmed.indexOf("/");
    const topLevel = firstSlash === -1 ? trimmed : trimmed.slice(0, firstSlash + 1);
    const name = topLevel.replace(/\/$/, "");
    if (!name || seen.has(name)) continue;
    seen.add(name);
    entries.push(name);
  }

  return entries;
}

async function symlinkOrCopyGitignoredFiles(input: {
  sourceRepoPath: string;
  worktreePath: string;
}): Promise<void> {
  const entries = await getTopLevelGitignoredEntries(input.sourceRepoPath);

  for (const entry of entries) {
    const sourcePath = join(input.sourceRepoPath, entry);
    const targetPath = join(input.worktreePath, entry);

    try {
      // Skip if already exists in worktree (tracked file or previously created)
      const existing = await lstat(targetPath).catch(() => null);
      if (existing) continue;

      const sourceStat = await lstat(sourcePath).catch(() => null);
      if (!sourceStat) continue;

      if (sourceStat.isDirectory()) {
        // Large directories → symlink
        await symlink(sourcePath, targetPath);
      } else if (sourceStat.isFile()) {
        // Small files → copy (avoids shared-mutation for .env etc.)
        await copyFile(sourcePath, targetPath);
      }
    } catch {
      // Silently continue on individual failures (race conditions, permissions, etc.)
    }
  }
}

async function syncGitignoredFilesBackToSource(input: {
  sourceRepoPath: string;
  worktreePath: string;
}): Promise<void> {
  const entries = await getTopLevelGitignoredEntries(input.sourceRepoPath);

  for (const entry of entries) {
    const worktreeEntryPath = join(input.worktreePath, entry);
    const sourceEntryPath = join(input.sourceRepoPath, entry);

    try {
      const worktreeStat = await lstat(worktreeEntryPath).catch(() => null);
      if (!worktreeStat) continue;

      // If it's still a symlink, source already has the content — nothing to do
      if (worktreeStat.isSymbolicLink()) continue;

      if (worktreeStat.isFile()) {
        // Agent replaced copied file — copy it back to source
        await copyFile(worktreeEntryPath, sourceEntryPath);
      } else if (worktreeStat.isDirectory()) {
        // Agent replaced symlink with real directory — copy back to source
        await rm(sourceEntryPath, { recursive: true, force: true });
        await cp(worktreeEntryPath, sourceEntryPath, { recursive: true });
      }
    } catch {
      // Silently continue on individual failures
    }
  }
}

async function discoverFlatRepoPaths(paths: WorkspacePathsLike): Promise<string[]> {
  const rootRepo = await isGitRepo(paths.workspaceDir);
  if (!rootRepo) {
    throw new Error(`Workspace root is not a git repo: ${paths.workspaceDir}`);
  }

  const discovered: string[] = ["."];
  const entries = await readdir(paths.codeDir, { withFileTypes: true }).catch(() => []);

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    if (entry.name.startsWith(".")) {
      continue;
    }

    const childPath = join(paths.codeDir, entry.name);
    if (!(await hasGitMarker(childPath))) {
      continue;
    }

    const trackedByCodeRepo = await isPathTrackedByRepo(paths.workspaceDir, `code/${entry.name}`);
    if (trackedByCodeRepo) {
      throw new Error(
        `Nested repo path is tracked by workspace/code repo and is not supported: code/${entry.name}`,
      );
    }

    discovered.push(`code/${entry.name}`);
  }

  const normalized = discovered.map((value) => normalizeRelativeRepoPath(value));
  const unique = [...new Set(normalized)];
  unique.sort((a, b) => {
    if (a === ".") return -1;
    if (b === ".") return 1;
    return a.localeCompare(b);
  });

  return unique;
}

async function getCurrentBranch(repoPath: string): Promise<string> {
  return (await runGitCapture(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
}

async function ensureGitRepo(repoPath: string): Promise<void> {
  if (await isGitRepo(repoPath)) {
    return;
  }
  await runGit(repoPath, ["init"]);
}

async function ensureRootGitIgnore(workspaceDir: string): Promise<void> {
  const gitIgnorePath = join(workspaceDir, ".gitignore");
  const existing = await readFile(gitIgnorePath, "utf8").catch(() => "");
  const required = ["code/", "outputs/"];
  const lines = existing
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  let changed = false;

  for (const entry of required) {
    if (!lines.includes(entry)) {
      lines.push(entry);
      changed = true;
    }
  }

  if (!existing.trim()) {
    changed = true;
  }
  if (!changed) {
    return;
  }

  const content = `${lines.join("\n")}\n`;
  await writeFile(gitIgnorePath, content, "utf8");
}

async function ensureDefaultCodeRepo(codeDir: string): Promise<void> {
  const defaultRepoDir = join(codeDir, "default");
  await mkdir(defaultRepoDir, { recursive: true });

  if (!(await isGitRepo(defaultRepoDir))) {
    await runGit(defaultRepoDir, ["init"]);
  }

  if (await hasAnyCommits(defaultRepoDir)) {
    return;
  }

  const readmePath = join(defaultRepoDir, "README.md");
  const existing = await readFile(readmePath, "utf8").catch(() => "");
  if (!existing.trim()) {
    const content = [
      "# Default Code Repo",
      "",
      "This repository is created automatically for Pragma workspaces.",
      "",
    ].join("\n");
    await writeFile(readmePath, content, "utf8");
  }

  await runGit(defaultRepoDir, ["add", "-A"]);
  const identity = await getUserGitIdentity(defaultRepoDir);
  await runGit(
    defaultRepoDir,
    buildCommitArgs(identity, "pragma: initialize default code repo", ["--allow-empty"]),
  );
}

async function commitIfNeeded(repoPath: string, message: string): Promise<void> {
  await runGit(repoPath, ["add", "-A"]);
  if (!(await hasStagedChanges(repoPath))) {
    return;
  }
  const identity = await getUserGitIdentity(repoPath);
  await runGit(repoPath, buildCommitArgs(identity, message));
}

async function hasAnyCommits(repoPath: string): Promise<boolean> {
  try {
    await runGit(repoPath, ["rev-parse", "--verify", "HEAD"]);
    return true;
  } catch {
    return false;
  }
}

async function primeConflictInTaskRepo(taskRepoPath: string, baseBranch: string): Promise<void> {
  if (!(await isDirectory(taskRepoPath))) {
    return;
  }

  await runGitSafe(taskRepoPath, ["merge", "--abort"]);
  await runGitSafe(taskRepoPath, ["reset", "--hard", "HEAD"]);
  await runGitSafe(taskRepoPath, ["clean", "-fd"]);

  try {
    await runGit(taskRepoPath, ["merge", "--no-commit", "--no-ff", baseBranch]);
  } catch {
    // Leave merge conflict state in the task worktree for retry resolution.
  }
}

async function listUnmergedFiles(repoPath: string): Promise<string[]> {
  const output = await runGitCapture(repoPath, ["diff", "--name-only", "--diff-filter=U"]);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

function normalizeRelativeRepoPath(value: string): string {
  const normalized = value
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .trim();
  if (!normalized || normalized === ".") {
    return ".";
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    throw new Error(`Invalid repo path: ${value}`);
  }
  return segments.join("/");
}

function collectManagedTopLevelCodeRepoNames(managedCodeRepoPaths: string[]): Set<string> {
  const names = new Set<string>();
  for (const path of managedCodeRepoPaths) {
    if (!path.startsWith("code/")) {
      continue;
    }
    const suffix = path.slice("code/".length);
    if (!suffix || suffix.includes("/")) {
      continue;
    }
    names.add(suffix);
  }
  return names;
}

async function seedNonRepoCodeIntoTaskWorkspace(input: {
  sourceCodeDir: string;
  targetCodeDir: string;
  managedCodeRepoPaths: string[];
}): Promise<void> {
  const managedRepoNames = collectManagedTopLevelCodeRepoNames(input.managedCodeRepoPaths);
  const entries = await readdir(input.sourceCodeDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    if (managedRepoNames.has(entry.name)) {
      continue;
    }
    const sourcePath = join(input.sourceCodeDir, entry.name);
    const targetPath = join(input.targetCodeDir, entry.name);
    await cp(sourcePath, targetPath, { recursive: true, force: true });
  }
}

async function syncNonRepoCodeBackToWorkspace(input: {
  sourceCodeDir: string;
  targetCodeDir: string;
  managedCodeRepoPaths: string[];
}): Promise<void> {
  const managedRepoNames = collectManagedTopLevelCodeRepoNames(input.managedCodeRepoPaths);
  await mkdir(input.targetCodeDir, { recursive: true });
  const entries = await readdir(input.sourceCodeDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      continue;
    }
    if (managedRepoNames.has(entry.name)) {
      continue;
    }
    const sourcePath = join(input.sourceCodeDir, entry.name);
    const targetPath = join(input.targetCodeDir, entry.name);
    await cp(sourcePath, targetPath, { recursive: true, force: true });
  }
}

export async function syncTaskOutputsBackToWorkspace(input: {
  workspacePaths: WorkspacePathsLike;
  taskId: string;
}): Promise<void> {
  const sourceOutputDir = getTaskWorktreeOutputDir(input.workspacePaths, input.taskId);
  if (!(await isDirectory(sourceOutputDir))) {
    return;
  }

  const entries = await readdir(sourceOutputDir, { withFileTypes: true }).catch(() => []);
  const copyable = entries.filter((e) => !e.name.startsWith(".") && e.name !== "events.jsonl");
  if (copyable.length === 0) {
    return;
  }

  const targetOutputDir = getTaskMainOutputDir(input.workspacePaths, input.taskId);
  await mkdir(input.workspacePaths.outputsDir, { recursive: true });
  await rm(targetOutputDir, { recursive: true, force: true });
  await mkdir(targetOutputDir, { recursive: true });

  for (const entry of copyable) {
    const sourcePath = join(sourceOutputDir, entry.name);
    const targetPath = join(targetOutputDir, entry.name);
    await cp(sourcePath, targetPath, { recursive: true, force: true });
  }
}

async function isPathTrackedByRepo(repoPath: string, relativePath: string): Promise<boolean> {
  try {
    await runGit(repoPath, ["ls-files", "--error-unmatch", "--", relativePath]);
    return true;
  } catch {
    return false;
  }
}

async function hasStagedChanges(repoPath: string): Promise<boolean> {
  try {
    await runGit(repoPath, ["diff", "--cached", "--quiet"]);
    return false;
  } catch {
    return true;
  }
}

async function gitBranchExists(repoPath: string, branchName: string): Promise<boolean> {
  try {
    await runGit(repoPath, ["show-ref", "--verify", "--quiet", `refs/heads/${branchName}`]);
    return true;
  } catch {
    return false;
  }
}

async function hasGitMarker(path: string): Promise<boolean> {
  const markerPath = join(path, ".git");
  const marker = await stat(markerPath).catch(() => null);
  return Boolean(marker?.isDirectory() || marker?.isFile());
}

async function isDirectory(path: string): Promise<boolean> {
  const info = await stat(path).catch(() => null);
  return Boolean(info?.isDirectory());
}

async function isGitRepo(path: string): Promise<boolean> {
  try {
    const topLevel = (await runGitCapture(path, ["rev-parse", "--show-toplevel"])).trim();
    return resolve(topLevel) === resolve(path);
  } catch {
    return false;
  }
}

async function runGitSafe(cwd: string, args: string[]): Promise<void> {
  try {
    await runGit(cwd, args);
  } catch {
    // Swallow cleanup failures.
  }
}

async function runGit(cwd: string, args: string[]): Promise<string> {
  return runCommand({
    command: "git",
    args,
    cwd,
    env: process.env,
  });
}

async function runGitCapture(cwd: string, args: string[]): Promise<string> {
  return runCommand({
    command: "git",
    args,
    cwd,
    env: process.env,
  });
}

type GitIdentity = { name: string; email: string };

async function getUserGitIdentity(repoPath: string): Promise<GitIdentity | null> {
  try {
    const name = (await runGitCapture(repoPath, ["config", "user.name"])).trim();
    const email = (await runGitCapture(repoPath, ["config", "user.email"])).trim();
    if (name && email) {
      return { name, email };
    }
    return null;
  } catch {
    return null;
  }
}

function buildCommitArgs(
  identity: GitIdentity | null,
  message: string,
  extraFlags?: string[],
): string[] {
  const userIdentity = identity ?? { name: "Pragma", email: "pragma@local" };
  const commitMessage = identity
    ? `${message}\n\nCo-Authored-By: Pragma <pragma@local>`
    : message;
  return [
    "-c",
    `user.name=${userIdentity.name}`,
    "-c",
    `user.email=${userIdentity.email}`,
    "commit",
    ...(extraFlags ?? []),
    "-m",
    commitMessage,
  ];
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Returns a git log summary of commits that landed on the base branch
 * between baseCommit and current HEAD, filtered to the given files.
 * This is a read-only operation on the source repo (not the task worktree).
 */
export async function getMainChangesSummary(input: {
  sourceRepoPath: string;
  baseCommit: string;
  baseBranch: string;
  files: string[];
}): Promise<string> {
  if (input.files.length === 0) {
    return "";
  }
  try {
    const output = await runGitCapture(input.sourceRepoPath, [
      "log",
      "--oneline",
      `${input.baseCommit}..${input.baseBranch}`,
      "--",
      ...input.files,
    ]);
    return output.trim();
  } catch {
    return "(unable to retrieve main branch changes)";
  }
}
