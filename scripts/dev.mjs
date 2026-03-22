#!/usr/bin/env node

import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import process from "node:process";

const apiPort = process.env.PRAGMA_DEV_API_PORT || "3001";
const uiPort = process.env.PRAGMA_DEV_UI_PORT || "5174";
const host = "127.0.0.1";
const rootDir = process.cwd();
const tscBin = resolve(rootDir, "node_modules", "typescript", "bin", "tsc");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const initialBuild = spawnSync(
  process.execPath,
  [tscBin, "--pretty", "false"],
  {
    cwd: rootDir,
    stdio: "inherit",
    env: process.env,
  },
);

if (typeof initialBuild.status === "number" && initialBuild.status !== 0) {
  process.exit(initialBuild.status);
}

console.log(`Pragma dev API: http://${host}:${apiPort}`);
console.log(`Pragma dev UI:  http://${host}:${uiPort}`);

const children = [];
let shuttingDown = false;

function spawnChild(command, args, extraEnv = {}) {
  const child = spawn(command, args, {
    cwd: rootDir,
    stdio: "inherit",
    env: {
      ...process.env,
      ...extraEnv,
    },
  });
  children.push(child);
  child.on("exit", (code, signal) => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    stopChildren();
    if (signal) {
      process.kill(process.pid, signal);
      return;
    }
    process.exit(code ?? 0);
  });
  return child;
}

function stopChildren() {
  for (const child of children) {
    if (child.exitCode !== null || child.signalCode) {
      continue;
    }
    child.kill("SIGTERM");
  }
}

process.once("SIGINT", () => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  stopChildren();
});

process.once("SIGTERM", () => {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  stopChildren();
});

spawnChild(process.execPath, [tscBin, "-w", "--preserveWatchOutput", "--pretty", "false"]);
spawnChild(process.execPath, [
  "--watch",
  "dist/cli/index.js",
  "server",
  "--port",
  apiPort,
  "--skip-orphan-recovery",
]);
spawnChild(
  npmCommand,
  ["run", "ui:dev", "--", "--host", host, "--port", uiPort],
  { VITE_API_URL: `http://${host}:${apiPort}` },
);
