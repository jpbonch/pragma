import { resolve } from "node:path";
import type { AdapterSendTurnInput, AdapterSendTurnResult, ConversationAdapter } from "../types";
import { registerAdapter } from "../adapterRegistry";
import {
  runAdapterCommand,
  withReasoningEffort,
  readString,
  readObject,
  readArray,
  readBoolean,
  appendText,
} from "../adapters";

/**
 * Tools that mutate files. Blocked in chat mode so the agent can only read.
 */
const CHAT_DISALLOWED_TOOLS = ["Edit", "Write", "NotebookEdit"];

const claudeAdapter: ConversationAdapter = {
  async sendTurn(input: AdapterSendTurnInput): Promise<AdapterSendTurnResult> {
    const args = buildClaudeArgs(input);
    return runAdapterCommand({
      command: "claude",
      args,
      cwd: input.cwd,
      env: input.env,
      abortSignal: input.abortSignal,
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

function buildClaudeArgs(input: AdapterSendTurnInput): string[] {
  const prompt = withReasoningEffort(input.prompt, input.reasoningEffort);
  const resolvedCwd = resolve(input.cwd);
  const args = [
    "-p",
    "--output-format",
    "stream-json",
    "--verbose",
    "--allow-dangerously-skip-permissions",
    "--dangerously-skip-permissions",
    "--permission-mode",
    "bypassPermissions",
    "--add-dir",
    resolvedCwd,
    "--model",
    input.modelId,
  ];

  if (input.mode === "chat") {
    args.push("--disallowedTools", CHAT_DISALLOWED_TOOLS.join(","));
  }

  if (input.sessionId) {
    args.push("--resume", input.sessionId);
  }

  args.push("--", prompt);
  return args;
}

registerAdapter({
  id: "claude_code",
  command: "claude",
  models: {
    "Opus 4.6": "opus",
    "Sonnet 4.6": "sonnet",
    "Haiku 4.5": "haiku",
  },
  titleModelId: "haiku",
  globalSkillsDirs: [
    { dir: ".claude/skills", label: "Claude Code" },
    { dir: ".agents/skills", label: "Agents" },
  ],
  mcpConfigFiles: [{ path: ".claude.json", key: "mcpServers" }],
  createAdapter: () => claudeAdapter,
});
