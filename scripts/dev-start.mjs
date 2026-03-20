import { cp, mkdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const sourcePragmaDir = resolve(process.env.PRAGMA_DEV_SOURCE_DIR || join(homedir(), ".pragma"));
const targetPragmaDir = resolve(process.env.PRAGMA_DIR || join(repoRoot, ".pragma-dev"));
const shouldRefresh = process.env.PRAGMA_DEV_REFRESH !== "0";

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function runCommand(command, args, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      stdio: "inherit",
      env,
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited with signal ${signal}`));
        return;
      }
      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code ?? -1}`));
        return;
      }
      resolvePromise();
    });
  });
}

async function preparePragmaDir() {
  if (!(await pathExists(sourcePragmaDir))) {
    await mkdir(targetPragmaDir, { recursive: true });
    console.log(`[dev] source Pragma dir not found, using empty state: ${targetPragmaDir}`);
    return;
  }

  if (shouldRefresh) {
    await rm(targetPragmaDir, { recursive: true, force: true });
    await cp(sourcePragmaDir, targetPragmaDir, {
      recursive: true,
      force: true,
      dereference: false,
    });
    console.log(`[dev] copied Pragma state: ${sourcePragmaDir} -> ${targetPragmaDir}`);
    return;
  }

  if (!(await pathExists(targetPragmaDir))) {
    await cp(sourcePragmaDir, targetPragmaDir, {
      recursive: true,
      force: true,
      dereference: false,
    });
    console.log(`[dev] initialized Pragma state: ${sourcePragmaDir} -> ${targetPragmaDir}`);
    return;
  }

  console.log(`[dev] reusing Pragma state: ${targetPragmaDir}`);
}

async function main() {
  await preparePragmaDir();

  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
  await runCommand(npmCommand, ["run", "build"], process.env);

  const child = spawn(process.execPath, [join(repoRoot, "dist", "cli", "index.js")], {
    cwd: repoRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      PRAGMA_DIR: targetPragmaDir,
    },
  });

  const forwardSignal = (signal) => {
    if (!child.killed) {
      child.kill(signal);
    }
  };

  process.once("SIGINT", () => forwardSignal("SIGINT"));
  process.once("SIGTERM", () => forwardSignal("SIGTERM"));

  child.on("exit", (code, signal) => {
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
