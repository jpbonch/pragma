import type {
  AdapterSendTurnInput,
  AdapterSendTurnResult,
  ConversationAdapter,
} from "./types";
import { getAdapterDefinition } from "./adapterRegistry";
import { spawnCommand } from "../process/runCommand";

export function getConversationAdapter(harness: string): ConversationAdapter {
  return getAdapterDefinition(harness).createAdapter();
}

export type RunAdapterCommandInput = {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  abortSignal?: AbortSignal;
  onJsonLine: (line: Record<string, unknown>, state: RunState) => Promise<void>;
};

export type RunState = {
  sessionId: string | null;
  finalText: string;
  commandError: string | null;
};

export async function runAdapterCommand(input: RunAdapterCommandInput): Promise<AdapterSendTurnResult> {
  const state: RunState = {
    sessionId: null,
    finalText: "",
    commandError: null,
  };

  const child = spawnCommand({
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    env: {
      ...process.env,
      ...(input.env ?? {}),
    },
    stdio: "pipe",
    stdin: "ignore",
  });

  let stderrText = "";
  let stdoutBuffer = "";
  let processing = Promise.resolve();
  let spawnErrorMessage = "";

  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuffer += chunk;
    let newlineIndex = stdoutBuffer.indexOf("\n");

    while (newlineIndex !== -1) {
      const line = stdoutBuffer.slice(0, newlineIndex).trim();
      stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);
      if (line.length > 0) {
        processing = processing.then(async () => {
          const parsed = safeJsonParse(line);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
            return;
          }
          await input.onJsonLine(parsed as Record<string, unknown>, state);
        });
      }
      newlineIndex = stdoutBuffer.indexOf("\n");
    }
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderrText += chunk;
  });

  child.once("error", (error: unknown) => {
    spawnErrorMessage = error instanceof Error ? error.message : String(error);
  });

  let aborted = false;
  const onAbort = () => {
    aborted = true;
    child.kill("SIGTERM");
  };
  if (input.abortSignal) {
    if (input.abortSignal.aborted) {
      child.kill("SIGTERM");
      aborted = true;
    } else {
      input.abortSignal.addEventListener("abort", onAbort, { once: true });
    }
  }

  let result: Awaited<typeof child>;
  try {
    result = await child;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${input.command} failed to start: ${spawnErrorMessage || message}`);
  } finally {
    input.abortSignal?.removeEventListener("abort", onAbort);
  }

  if (stdoutBuffer.trim()) {
    const parsed = safeJsonParse(stdoutBuffer.trim());
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      processing = processing.then(() => input.onJsonLine(parsed as Record<string, unknown>, state));
    }
  }

  await processing;

  if (spawnErrorMessage) {
    throw new Error(`${input.command} failed to start: ${spawnErrorMessage}`);
  }

  if (aborted) {
    return {
      sessionId: state.sessionId ?? "",
      finalText: state.finalText.trim(),
      aborted: true,
    };
  }

  if (state.commandError) {
    throw new Error(state.commandError);
  }

  if ((result.exitCode ?? -1) !== 0) {
    const reason = stderrText.trim() || result.stderr.trim() || `${input.command} exited with code ${result.exitCode ?? -1}`;
    throw new Error(reason);
  }

  if (!state.sessionId) {
    throw new Error(`${input.command} did not return a session id.`);
  }

  return {
    sessionId: state.sessionId,
    finalText: state.finalText.trim(),
  };
}

export function withReasoningEffort(
  prompt: string,
  reasoningEffort: AdapterSendTurnInput["reasoningEffort"],
): string {
  const effort = reasoningEffort ?? "medium";
  if (effort === "medium") {
    return prompt;
  }
  const readable =
    effort === "extra_high" ? "extra high" : effort;
  return `Reasoning effort is ${readable}. Follow that effort level in your internal reasoning depth.\n\n${prompt}`;
}

export function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export function appendText(current: string, next: string): string {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  return `${current}\n${next}`;
}

export function readObject(
  value: unknown,
  key: string,
): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }

  const candidate = (value as Record<string, unknown>)[key];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    return {};
  }

  return candidate as Record<string, unknown>;
}

export function readArray(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const candidate = (value as Record<string, unknown>)[key];
  return Array.isArray(candidate) ? candidate : [];
}

export function readString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : null;
}

export function readBoolean(value: unknown, key: string): boolean | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "boolean" ? candidate : null;
}

// Side-effect requires: load adapter registrations.
// Using require() instead of import so they execute after all exports are defined,
// avoiding circular-dependency issues with CommonJS module resolution.
require("./adapters/codexAdapter");
require("./adapters/claudeAdapter");
