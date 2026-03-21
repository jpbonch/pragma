import { resolve } from "node:path";
import type { AdapterSendTurnInput, AdapterSendTurnResult, ConversationAdapter, ReasoningEffort } from "../types";
import { registerAdapter } from "../adapterRegistry";
import {
  runAdapterCommand,
  readString,
  readObject,
  appendText,
} from "../adapters";

const codexAdapter: ConversationAdapter = {
  async sendTurn(input: AdapterSendTurnInput): Promise<AdapterSendTurnResult> {
    const args = buildCodexArgs(input);
    return runAdapterCommand({
      command: "codex",
      args,
      cwd: input.cwd,
      env: input.env,
      abortSignal: input.abortSignal,
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

/**
 * Map Pragma reasoning effort to Codex CLI model_reasoning_effort values.
 * Codex CLI accepts: minimal | low | medium | high | xhigh
 * Pragma has: low | medium | high | extra_high
 */
function mapCodexEffort(effort: ReasoningEffort | undefined): string {
  switch (effort) {
    case "low": return "low";
    case "high": return "high";
    case "extra_high": return "xhigh";
    case "medium":
    default:
      return "medium";
  }
}

function buildCodexArgs(input: AdapterSendTurnInput): string[] {
  const resolvedCwd = resolve(input.cwd);
  const topLevelArgs =
    input.mode === "chat"
      ? ["-s", "read-only", "-a", "never", "-C", resolvedCwd]
      : ["-C", resolvedCwd];

  topLevelArgs.push("-c", `model_reasoning_effort=${mapCodexEffort(input.reasoningEffort)}`);

  const execSandboxArgs =
    input.mode === "chat" ? [] : ["-s", "danger-full-access"];

  if (input.sessionId) {
    return [
      ...topLevelArgs,
      "exec",
      ...execSandboxArgs,
      "resume",
      "--json",
      "--skip-git-repo-check",
      "--model",
      input.modelId,
      input.sessionId,
      input.prompt,
    ];
  }

  return [
    ...topLevelArgs,
    "exec",
    ...execSandboxArgs,
    "--json",
    "--skip-git-repo-check",
    "--model",
    input.modelId,
    input.prompt,
  ];
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

registerAdapter({
  id: "codex",
  command: "codex",
  models: {
    "GPT-5": "gpt-5",
    "GPT-5.3-Codex": "gpt-5.3-codex",
  },
  globalSkillsDirs: [
    { dir: ".agents/skills", label: "Codex" },
  ],
  createAdapter: () => codexAdapter,
});
