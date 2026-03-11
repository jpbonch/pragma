#!/usr/bin/env node

import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { join } from "node:path";
import { Command } from "commander";

const program = new Command();
const DEFAULT_API_URL = process.env.SALMON_API_URL ?? "http://127.0.0.1:3000";
const DEFAULT_UI_URL = process.env.SALMON_UI_URL ?? "http://127.0.0.1:5173";

program
  .name("salmon")
  .description("Very minimal CLI")
  .version("0.1.0")
  .action(async () => {
    await runAll();
  });

program
  .command("setup")
  .description("Call the API setup endpoint")
  .option("-u, --api-url <url>", "Salmon API base URL", DEFAULT_API_URL)
  .action(async (options: { apiUrl: string }) => {
    await apiRequest(options.apiUrl, "/setup", { method: "POST" });
    console.log("Setup complete.");
  });

program
  .command("create-job")
  .description("Call the API to create a job")
  .argument("<title>", "Job title")
  .option("-a, --assigned-to <agentId>", "Assigned agent id")
  .option("-o, --output-dir <outputDir>", "Output directory")
  .option("-s, --status <status>", "Job status", "open")
  .option("-u, --api-url <url>", "Salmon API base URL", DEFAULT_API_URL)
  .action(
    async (
      title: string,
      options: {
        assignedTo?: string;
        outputDir?: string;
        status: string;
        apiUrl: string;
      },
    ) => {
      const result = await apiRequest<{ id: string }>(options.apiUrl, "/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          status: options.status,
          assigned_to: options.assignedTo,
          output_dir: options.outputDir,
        }),
      });

      console.log(`Created job ${result.id}`);
    },
  );

program
  .command("list-jobs")
  .description("Call the API to list jobs")
  .option("-s, --status <status>", "Filter by status")
  .option("-l, --limit <limit>", "Maximum jobs to return", "25")
  .option("-u, --api-url <url>", "Salmon API base URL", DEFAULT_API_URL)
  .action(
    async (options: { status?: string; limit: string; apiUrl: string }) => {
      const params = new URLSearchParams();
      if (options.status) {
        params.set("status", options.status);
      }
      params.set("limit", options.limit);

      const result = await apiRequest<{ jobs: Record<string, unknown>[] }>(
        options.apiUrl,
        `/jobs?${params.toString()}`,
      );

      if (result.jobs.length === 0) {
        console.log("No jobs found.");
        return;
      }

      console.table(result.jobs);
    },
  );

program
  .command("server")
  .description("Start the Salmon API server")
  .option("-p, --port <port>", "Port to listen on", "3000")
  .action(async (options: { port: string }) => {
    const port = parsePort(options.port);
    const { startServer } = await import("../server");
    await startServer({ port });
  });

program
  .command("ui")
  .description("Start the Salmon UI")
  .option("-p, --port <port>", "UI port", "5173")
  .option("-u, --api-url <url>", "Salmon API base URL", DEFAULT_API_URL)
  .action(async (options: { port: string; apiUrl: string }) => {
    await startUi({
      port: parsePort(options.port),
      apiUrl: options.apiUrl,
    });
  });

async function runAll(): Promise<void> {
  const apiUrl = DEFAULT_API_URL;
  const uiUrl = DEFAULT_UI_URL;
  const serverPort = parsePort(new URL(apiUrl).port || "3000");
  const uiPort = parsePort(new URL(uiUrl).port || "5173");

  const serverProcess = spawnSelfCommand(["server", "--port", String(serverPort)]);

  await waitForHealth(apiUrl);

  const uiProcess = spawnSelfCommand([
    "ui",
    "--port",
    String(uiPort),
    "--api-url",
    apiUrl,
  ]);

  openBrowser(uiUrl);

  const stop = () => {
    serverProcess.kill("SIGTERM");
    uiProcess.kill("SIGTERM");
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  await Promise.race([
    waitForExit(serverProcess, "server"),
    waitForExit(uiProcess, "ui"),
  ]);
}

async function startUi(options: { port: number; apiUrl: string }): Promise<void> {
  const uiDir = await resolveUiDir();
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

  const child = spawn(
    npmCommand,
    ["run", "dev", "--", "--host", "127.0.0.1", "--port", String(options.port)],
    {
      cwd: uiDir,
      stdio: "inherit",
      env: {
        ...process.env,
        VITE_API_URL: options.apiUrl,
      },
    },
  );

  await waitForExit(child, "ui");
}

async function resolveUiDir(): Promise<string> {
  const candidates = [
    join(__dirname, "..", "..", "ui"),
    join(__dirname, "..", "ui"),
    join(process.cwd(), "ui"),
  ];

  for (const candidate of candidates) {
    if (await pathExists(candidate)) {
      return candidate;
    }
  }

  throw new Error("UI folder not found.");
}

async function waitForHealth(apiUrl: string): Promise<void> {
  const timeoutMs = 15000;
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    try {
      await apiRequest(apiUrl, "/health");
      return;
    } catch {
      await sleep(250);
    }
  }

  throw new Error("Server did not become ready in time.");
}

function spawnSelfCommand(args: string[]) {
  return spawn(process.execPath, [process.argv[1], ...args], {
    stdio: "inherit",
    env: process.env,
  });
}

function waitForExit(
  child: ReturnType<typeof spawn>,
  name: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (code === 0 || code === null || signal === "SIGINT" || signal === "SIGTERM") {
        resolve();
        return;
      }
      reject(new Error(`${name} exited with code ${code}`));
    });
  });
}

async function apiRequest<T = Record<string, unknown>>(
  apiUrl: string,
  path: string,
  init?: RequestInit,
): Promise<T> {
  const base = apiUrl.replace(/\/$/, "");
  const response = await fetch(`${base}${path}`, init);

  if (!response.ok) {
    let message = `HTTP ${response.status}`;
    try {
      const body = (await response.json()) as { error?: string };
      if (body.error) {
        message = body.error;
      }
    } catch {
      // Keep default message.
    }
    throw new Error(message);
  }

  if (response.status === 204) {
    return {} as T;
  }

  return (await response.json()) as T;
}

function parsePort(portValue: string): number {
  const port = Number.parseInt(portValue, 10);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid --port value: ${portValue}. Use an integer 1-65535.`);
  }
  return port;
}

function openBrowser(url: string): void {
  if (process.platform === "darwin") {
    spawn("open", [url], { stdio: "ignore", detached: true }).unref();
    return;
  }

  if (process.platform === "win32") {
    spawn("cmd", ["/c", "start", "", url], {
      stdio: "ignore",
      detached: true,
    }).unref();
    return;
  }

  spawn("xdg-open", [url], { stdio: "ignore", detached: true }).unref();
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

program.parseAsync(process.argv).catch((error: unknown) => {
  console.error(errorMessage(error));
  process.exitCode = 1;
});
