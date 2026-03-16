#!/usr/bin/env node

import { access } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Command } from "commander";
import open from "open";
import type { ExecaChildProcess } from "execa";
import { spawnCommand, spawnNodeCommand } from "../server/process/runCommand";

const program = new Command();
const DEFAULT_API_URL = process.env.PRAGMA_API_URL ?? "http://127.0.0.1:3000";
const DEFAULT_UI_URL = process.env.PRAGMA_UI_URL ?? "http://127.0.0.1:5173";

if (!process.env.PRAGMA_CLI_COMMAND) {
  const entry = process.argv[1] ? quoteShellArg(process.argv[1]) : "pragma";
  process.env.PRAGMA_CLI_COMMAND = `${quoteShellArg(process.execPath)} ${entry}`;
}

program
  .name("pragma")
  .description("Very minimal CLI")
  .version("0.1.0")
  .action(async () => {
    await runAll();
  });

program
  .command("setup")
  .description("Call the API setup endpoint")
  .option("-u, --api-url <url>", "Pragma API base URL", DEFAULT_API_URL)
  .action(async (options: { apiUrl: string }) => {
    await apiRequest(options.apiUrl, "/setup", { method: "POST" });
    console.log("Setup complete.");
  });

program
  .command("create-task")
  .description("Call the API to create a task")
  .argument("<title>", "Task title")
  .option("-a, --assigned-to <agentId>", "Assigned agent id")
  .option("-o, --output-dir <outputDir>", "Output directory")
  .option("-s, --status <status>", "Task status", "queued")
  .option("-u, --api-url <url>", "Pragma API base URL", DEFAULT_API_URL)
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
      const result = await apiRequest<{ id: string }>(options.apiUrl, "/tasks", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          title,
          status: options.status,
          assigned_to: options.assignedTo,
          output_dir: options.outputDir,
        }),
      });

      console.log(`Created task ${result.id}`);
    },
  );

program
  .command("list-tasks")
  .description("Call the API to list tasks")
  .option("-s, --status <status>", "Filter by status")
  .option("-l, --limit <limit>", "Maximum tasks to return", "25")
  .option("-u, --api-url <url>", "Pragma API base URL", DEFAULT_API_URL)
  .action(
    async (options: { status?: string; limit: string; apiUrl: string }) => {
      const params = new URLSearchParams();
      if (options.status) {
        params.set("status", options.status);
      }
      params.set("limit", options.limit);

      const result = await apiRequest<{ tasks: Record<string, unknown>[] }>(
        options.apiUrl,
        `/tasks?${params.toString()}`,
      );

      if (result.tasks.length === 0) {
        console.log("No tasks found.");
        return;
      }

      console.table(result.tasks);
    },
  );

program
  .command("list-agents")
  .description("Call the API to list all agents")
  .option("-u, --api-url <url>", "Pragma API base URL", DEFAULT_API_URL)
  .action(async (options: { apiUrl: string }) => {
    const result = await apiRequest<{
      agents: Array<{
        id: string;
        name: string;
        status: string;
        harness: string;
        model_label: string;
      }>;
    }>(options.apiUrl, "/agents");

    if (result.agents.length === 0) {
      console.log("No agents found.");
      return;
    }

    console.table(result.agents);
  });

const taskCommand = program
  .command("task")
  .description("Agent task-control commands");

taskCommand
  .command("select-recipient")
  .description("Select a worker recipient for the current orchestrating task")
  .requiredOption("--agent-id <id>", "Worker agent id")
  .requiredOption("--reason <text>", "Selection reason")
  .option("--task-id <id>", "Task id")
  .option("--turn-id <id>", "Turn id")
  .option("--api-url <url>", "Pragma API base URL")
  .action(
    async (options: {
      agentId: string;
      reason: string;
      taskId?: string;
      turnId?: string;
      apiUrl?: string;
    }) => {
      const { apiUrl, taskId, turnId } = resolveTaskCommandContext(options);
      const result = await apiRequest<{ assigned_to?: string }>(
        apiUrl,
        `/tasks/${encodeURIComponent(taskId)}/agent/select-recipient`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent_id: options.agentId,
            reason: options.reason,
            turn_id: turnId,
          }),
        },
      );

      const selected = result.assigned_to || options.agentId;
      console.log(`Selected recipient ${selected} for task ${taskId}.`);
    },
  );

taskCommand
  .command("plan-select-recipient")
  .description("Select a worker recipient for the current plan turn")
  .requiredOption("--agent-id <id>", "Worker agent id")
  .requiredOption("--reason <text>", "Selection reason")
  .option("--thread-id <id>", "Conversation thread id")
  .option("--turn-id <id>", "Conversation turn id")
  .option("--api-url <url>", "Pragma API base URL")
  .action(
    async (options: {
      agentId: string;
      reason: string;
      threadId?: string;
      turnId?: string;
      apiUrl?: string;
    }) => {
      const { apiUrl, threadId, turnId } = resolveThreadTurnCommandContext(options);
      const result = await apiRequest<{ selected_agent_id?: string }>(
        apiUrl,
        `/conversations/${encodeURIComponent(threadId)}/turns/${encodeURIComponent(turnId)}/agent/select-recipient`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            agent_id: options.agentId,
            reason: options.reason,
          }),
        },
      );

      const selected = result.selected_agent_id || options.agentId;
      console.log(`Selected plan recipient ${selected} for turn ${turnId}.`);
    },
  );

taskCommand
  .command("ask-question")
  .description("Pause execution and ask the human a clarification question")
  .requiredOption("--question <text>", "Question for the human")
  .option("--details <text>", "Optional context details")
  .option("--task-id <id>", "Task id")
  .option("--turn-id <id>", "Turn id")
  .option("--api-url <url>", "Pragma API base URL")
  .action(
    async (options: {
      question: string;
      details?: string;
      taskId?: string;
      turnId?: string;
      apiUrl?: string;
    }) => {
      const { apiUrl, taskId, turnId } = resolveTaskCommandContext(options);
      const agentId = normalizeOptionalString(process.env.PRAGMA_AGENT_ID);
      await apiRequest<{ status: string }>(
        apiUrl,
        `/tasks/${encodeURIComponent(taskId)}/agent/ask-question`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            question: options.question,
            details: options.details,
            turn_id: turnId,
            agent_id: agentId,
          }),
        },
      );

      console.log(`Question submitted for task ${taskId}.`);
    },
  );

taskCommand
  .command("request-help")
  .description("Pause execution and request human help")
  .requiredOption("--summary <text>", "Help summary")
  .option("--details <text>", "Optional context details")
  .option("--task-id <id>", "Task id")
  .option("--turn-id <id>", "Turn id")
  .option("--api-url <url>", "Pragma API base URL")
  .action(
    async (options: {
      summary: string;
      details?: string;
      taskId?: string;
      turnId?: string;
      apiUrl?: string;
    }) => {
      const { apiUrl, taskId, turnId } = resolveTaskCommandContext(options);
      const agentId = normalizeOptionalString(process.env.PRAGMA_AGENT_ID);
      await apiRequest<{ status: string }>(
        apiUrl,
        `/tasks/${encodeURIComponent(taskId)}/agent/request-help`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            summary: options.summary,
            details: options.details,
            turn_id: turnId,
            agent_id: agentId,
          }),
        },
      );

      console.log(`Help request submitted for task ${taskId}.`);
    },
  );

taskCommand
  .command("submit-test-commands")
  .description("Submit runnable test commands for the current task (appends by default)")
  .requiredOption(
    "--command <text>",
    "Test command (repeat for multiple commands)",
    (value: string, prev: string[]) => [...prev, value],
    [],
  )
  .requiredOption(
    "--cwd <path>",
    "Run directory aligned to --command order (repeatable, relative to task workspace root)",
    (value: string, prev: string[]) => [...prev, value],
    [],
  )
  .option(
    "--name <text>",
    "Optional button label aligned to --command order (repeatable)",
    (value: string, prev: string[]) => [...prev, value],
    [],
  )
  .option("--task-id <id>", "Task id")
  .option("--turn-id <id>", "Turn id")
  .option("--replace", "Replace existing commands instead of appending")
  .option("--api-url <url>", "Pragma API base URL")
  .action(
    async (options: {
      command: string[];
      cwd: string[];
      name: string[];
      taskId?: string;
      turnId?: string;
      replace?: boolean;
      apiUrl?: string;
    }) => {
      const { apiUrl, taskId, turnId } = resolveTaskCommandContext(options);
      const cwdByIndex = Array.isArray(options.cwd) ? options.cwd : [];
      const commands = (Array.isArray(options.command) ? options.command : [])
        .map((value, index) => {
          const command = value.trim();
          const cwd = (cwdByIndex[index] ?? "").trim();
          const label = (Array.isArray(options.name) ? options.name[index] : "")?.trim() || command;
          return { label, command, cwd };
        })
        .filter((item) => item.command.length > 0 && item.cwd.length > 0);

      if (commands.length === 0) {
        throw new Error("At least one --command and matching --cwd is required.");
      }
      if (commands.length !== (Array.isArray(options.command) ? options.command.length : 0)) {
        throw new Error("Each --command must include a matching --cwd at the same index.");
      }

      await apiRequest(
        apiUrl,
        `/tasks/${encodeURIComponent(taskId)}/agent/test-commands`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            commands,
            turn_id: turnId,
            agent_id: normalizeOptionalString(process.env.PRAGMA_AGENT_ID),
            replace: Boolean(options.replace),
          }),
        },
      );

      console.log(`Submitted ${commands.length} test command(s) for task ${taskId}.`);
    },
  );

program
  .command("server")
  .description("Start the Pragma API server")
  .option("-p, --port <port>", "Port to listen on", "3000")
  .action(async (options: { port: string }) => {
    const port = parsePort(options.port);
    const { startServer } = await import("../server");
    await startServer({ port });
  });

program
  .command("ui")
  .description("Start the Pragma UI")
  .option("-p, --port <port>", "UI port", "5173")
  .option("-u, --api-url <url>", "Pragma API base URL", DEFAULT_API_URL)
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
  const serverExit = waitForExit(serverProcess, "server");

  await waitForHealth(apiUrl);

  const uiProcess = spawnSelfCommand([
    "ui",
    "--port",
    String(uiPort),
    "--api-url",
    apiUrl,
  ]);
  const uiExit = waitForExit(uiProcess, "ui");

  try {
    await open(uiUrl, { wait: false });
  } catch (error) {
    console.warn(`Unable to open browser automatically: ${errorMessage(error)}`);
    console.warn(`Open ${uiUrl} manually.`);
  }

  let shuttingDown = false;

  const stop = () => {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    serverProcess.kill("SIGTERM");
    uiProcess.kill("SIGTERM");
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);

  const firstExit = await Promise.race([serverExit, uiExit]);

  if (!shuttingDown) {
    shuttingDown = true;
    serverProcess.kill("SIGTERM");
    uiProcess.kill("SIGTERM");

    await Promise.allSettled([serverExit, uiExit]);
    throw new Error(
      `${firstExit.name} exited unexpectedly with ${formatExit(firstExit)}.`,
    );
  }

  await Promise.allSettled([serverExit, uiExit]);
}

async function startUi(options: { port: number; apiUrl: string }): Promise<void> {
  const uiDir = await resolveUiDir();
  const projectRoot = dirname(uiDir);
  const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

  const child = spawnCommand({
    command: npmCommand,
    args: ["run", "ui:dev", "--", "--host", "127.0.0.1", "--port", String(options.port)],
    cwd: projectRoot,
    stdio: "inherit",
    env: {
      ...process.env,
      VITE_API_URL: options.apiUrl,
    },
  });

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
  return spawnNodeCommand({
    modulePath: __filename,
    args,
    cwd: process.cwd(),
    stdio: "inherit",
    env: process.env,
  });
}

function waitForExit(
  child: ExecaChildProcess<string>,
  name: string,
): Promise<{ name: string; exitCode: number | null; signal: string | undefined }> {
  return child.then((result) => {
    return {
      name,
      exitCode: result.exitCode,
      signal: result.signal,
    };
  });
}

function formatExit(result: {
  exitCode: number | null;
  signal: string | undefined;
}): string {
  if (result.signal) {
    return `signal ${result.signal}`;
  }
  if (result.exitCode === null) {
    return "unknown exit";
  }
  return `exit code ${result.exitCode}`;
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

function resolveTaskCommandContext(input: {
  apiUrl?: string;
  taskId?: string;
  turnId?: string;
}): {
  apiUrl: string;
  taskId: string;
  turnId?: string;
} {
  const apiUrl = resolveRequiredOptionOrEnv(input.apiUrl, "PRAGMA_API_URL", "--api-url");
  const taskId = resolveRequiredOptionOrEnv(input.taskId, "PRAGMA_TASK_ID", "--task-id");
  const turnId = normalizeOptionalString(input.turnId) || normalizeOptionalString(process.env.PRAGMA_TURN_ID);
  return { apiUrl, taskId, turnId };
}

function resolveThreadTurnCommandContext(input: {
  apiUrl?: string;
  threadId?: string;
  turnId?: string;
}): {
  apiUrl: string;
  threadId: string;
  turnId: string;
} {
  const apiUrl = resolveRequiredOptionOrEnv(input.apiUrl, "PRAGMA_API_URL", "--api-url");
  const threadId = resolveRequiredOptionOrEnv(input.threadId, "PRAGMA_THREAD_ID", "--thread-id");
  const turnId = resolveRequiredOptionOrEnv(input.turnId, "PRAGMA_TURN_ID", "--turn-id");
  return { apiUrl, threadId, turnId };
}

function resolveRequiredOptionOrEnv(
  optionValue: string | undefined,
  envName: string,
  optionLabel: string,
): string {
  const fromOption = normalizeOptionalString(optionValue);
  if (fromOption) {
    return fromOption;
  }

  const fromEnv = normalizeOptionalString(process.env[envName]);
  if (fromEnv) {
    return fromEnv;
  }

  throw new Error(`Missing ${optionLabel}. Pass ${optionLabel} or set ${envName}.`);
}

function normalizeOptionalString(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function quoteShellArg(value: string): string {
  return `"${value.replace(/["\\$`]/g, "\\$&")}"`;
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
