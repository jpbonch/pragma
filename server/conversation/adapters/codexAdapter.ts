import { resolve } from "node:path";
import type { AdapterSendTurnInput, AdapterSendTurnResult, ConversationAdapter } from "../types";
import { registerAdapter } from "../adapterRegistry";
import {
  runAdapterCommand,
  withReasoningEffort,
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

function buildCodexArgs(input: AdapterSendTurnInput): string[] {
  const prompt = withReasoningEffort(input.prompt, input.reasoningEffort);
  const resolvedCwd = resolve(input.cwd);
  const topLevelArgs =
    input.mode === "chat"
      ? ["-s", "read-only", "-a", "never", "-C", resolvedCwd]
      : ["-C", resolvedCwd];

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
      prompt,
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
    prompt,
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
