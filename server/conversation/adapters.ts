import type {
  AdapterSendTurnInput,
  AdapterSendTurnResult,
  ConversationAdapter,
  HarnessId,
} from "./types";
import { spawnCommand } from "../process/runCommand";

export function getConversationAdapter(harness: HarnessId): ConversationAdapter {
  if (harness === "codex") {
    return codexAdapter;
  }
  return claudeAdapter;
}

const codexAdapter: ConversationAdapter = {
  async sendTurn(input: AdapterSendTurnInput): Promise<AdapterSendTurnResult> {
    const args = buildCodexArgs(input);
    return runAdapterCommand({
      command: "codex",
      args,
      cwd: input.cwd,
      env: input.env,
      onJsonLine: async (line, state) => {
        const eventType = readString(line, "type");
        if (eventType === "thread.started") {
          const threadId = readString(line, "thread_id");
          if (threadId) {
            state.sessionId = threadId;
          }
          return;
        }

        if (eventType === "item.completed") {
          const item = readObject(line, "item");
          const itemType = readString(item, "type");

          if (itemType === "agent_message") {
            const text = readString(item, "text") ?? "";
            if (text) {
              state.finalText = appendText(state.finalText, text);
              await input.onEvent({ type: "assistant_text", delta: text });
            }
            return;
          }

          if (shouldEmitCodexToolEvent(itemType, item)) {
            await input.onEvent({
              type: "tool_event",
              name: `item.${itemType || "unknown"}`,
              payload: item,
            });
          }
          return;
        }

        if (eventType === "error" || eventType === "turn.failed") {
          state.commandError = readString(line, "message") || JSON.stringify(line);
          return;
        }

        // Ignore non-tool lifecycle noise like turn.started/turn.completed.
      },
    });
  },
};

const claudeAdapter: ConversationAdapter = {
  async sendTurn(input: AdapterSendTurnInput): Promise<AdapterSendTurnResult> {
    const args = buildClaudeArgs(input);
    return runAdapterCommand({
      command: "claude",
      args,
      cwd: input.cwd,
      env: input.env,
      onJsonLine: async (line, state) => {
        const eventType = readString(line, "type");

        if (eventType === "system") {
          const subtype = readString(line, "subtype");
          if (subtype === "init") {
            const sessionId = readString(line, "session_id");
            if (sessionId) {
              state.sessionId = sessionId;
            }
          }
          return;
        }

        if (eventType === "assistant") {
          const message = readObject(line, "message");
          const content = readArray(message, "content");

          for (const block of content) {
            if (typeof block !== "object" || block === null) {
              continue;
            }

            const blockType = readString(block, "type");
            if (blockType === "text") {
              const text = readString(block, "text") ?? "";
              if (text) {
                state.finalText = appendText(state.finalText, text);
                await input.onEvent({ type: "assistant_text", delta: text });
              }
              continue;
            }

            await input.onEvent({
              type: "tool_event",
              name: `assistant.${blockType || "block"}`,
              payload: block as Record<string, unknown>,
            });
          }
          return;
        }

        if (eventType === "result") {
          const isError = Boolean(readBoolean(line, "is_error"));
          const resultText = readString(line, "result") ?? "";
          if (resultText && !state.finalText) {
            state.finalText = resultText;
          }
          if (isError) {
            state.commandError = resultText || "Claude CLI returned an error.";
          }
          return;
        }
        // Ignore non-tool lifecycle noise (user/result/system echoes).
      },
    });
  },
};

type RunAdapterCommandInput = {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  onJsonLine: (line: Record<string, unknown>, state: RunState) => Promise<void>;
};

type RunState = {
  sessionId: string | null;
  finalText: string;
  commandError: string | null;
};

async function runAdapterCommand(input: RunAdapterCommandInput): Promise<AdapterSendTurnResult> {
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
  let result: Awaited<typeof child>;
  try {
    result = await child;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${input.command} failed to start: ${spawnErrorMessage || message}`);
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

function buildCodexArgs(input: AdapterSendTurnInput): string[] {
  const prompt = withReasoningEffort(input.prompt, input.reasoningEffort);
  if (input.sessionId) {
    return [
      "exec",
      "resume",
      "--json",
      "--skip-git-repo-check",
      "--dangerously-bypass-approvals-and-sandbox",
      "--model",
      input.modelId,
      input.sessionId,
      prompt,
    ];
  }

  return [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--dangerously-bypass-approvals-and-sandbox",
    "--model",
    input.modelId,
    prompt,
  ];
}

function buildClaudeArgs(input: AdapterSendTurnInput): string[] {
  const prompt = withReasoningEffort(input.prompt, input.reasoningEffort);
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--allow-dangerously-skip-permissions",
    "--dangerously-skip-permissions",
    "--permission-mode",
    "bypassPermissions",
    "--model",
    input.modelId,
  ];

  if (input.sessionId) {
    args.push("--resume", input.sessionId);
  }

  args.push(prompt);
  return args;
}

function withReasoningEffort(
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

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function appendText(current: string, next: string): string {
  if (!current) {
    return next;
  }
  if (!next) {
    return current;
  }
  return `${current}\n${next}`;
}

function readObject(
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

function readArray(value: unknown, key: string): unknown[] {
  if (!value || typeof value !== "object") {
    return [];
  }

  const candidate = (value as Record<string, unknown>)[key];
  return Array.isArray(candidate) ? candidate : [];
}

function readString(value: unknown, key: string): string | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "string" ? candidate : null;
}

function readBoolean(value: unknown, key: string): boolean | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const candidate = (value as Record<string, unknown>)[key];
  return typeof candidate === "boolean" ? candidate : null;
}

function shouldEmitCodexToolEvent(
  itemType: string | null,
  item: Record<string, unknown>,
): boolean {
  if (!itemType) {
    return false;
  }

  // Hide reasoning and other verbose metadata events.
  if (itemType === "reasoning" || itemType === "plan") {
    return false;
  }

  if (itemType.includes("tool")) {
    return true;
  }

  // Some codex event variants may include command/file ops without "tool" in type.
  if (typeof item.command === "string") {
    return true;
  }
  if (typeof item.file_path === "string") {
    return true;
  }

  return false;
}
