import type { PGlite } from "@electric-sql/pglite";
import { homedir } from "node:os";
import { DEFAULT_AGENT_ID } from "../db";
import { getConversationAdapter } from "./adapters";
import { getAdapterDefinition } from "./adapterRegistry";

const TITLE_SYSTEM_PROMPT = [
  "Generate a concise title (3-8 words) that summarizes the conversation.",
  "Rules:",
  "- No quotes around the title",
  "- No punctuation at the end",
  "- Use sentence case",
  "- Output ONLY the title, nothing else",
].join("\n");

const TITLE_TIMEOUT_MS = 10_000;

export async function generateTitle(
  db: PGlite,
  userMessage: string,
  assistantMessage: string,
): Promise<string> {
  try {
    const agent = await getAgentRow(db);
    if (!agent) {
      return deriveChatTitleFallback(userMessage, assistantMessage);
    }

    const harness = agent.harness;
    const def = getAdapterDefinition(harness);
    const modelId = def.titleModelId ?? agent.model_id;
    const adapter = getConversationAdapter(harness);

    const prompt = buildTitlePrompt(userMessage, assistantMessage);

    const result = await Promise.race([
      adapter.sendTurn({
        prompt,
        modelId,
        sessionId: null,
        cwd: homedir(),
        mode: "chat",
        onEvent: () => {},
      }),
      rejectAfterTimeout(TITLE_TIMEOUT_MS),
    ]);

    const title = result.finalText.trim();
    if (title && title.length <= 100) {
      return title;
    }

    return deriveChatTitleFallback(userMessage, assistantMessage);
  } catch {
    return deriveChatTitleFallback(userMessage, assistantMessage);
  }
}

function buildTitlePrompt(userMessage: string, assistantMessage: string): string {
  const parts = [TITLE_SYSTEM_PROMPT, "", "User message:", userMessage.slice(0, 500)];
  if (assistantMessage) {
    parts.push("", "Assistant response:", assistantMessage.slice(0, 500));
  }
  return parts.join("\n");
}

function rejectAfterTimeout(ms: number): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error("Title generation timed out")), ms);
  });
}

async function getAgentRow(
  db: PGlite,
): Promise<{ harness: string; model_id: string } | null> {
  const result = await db.query<{ harness: string; model_id: string }>(
    `SELECT harness, model_id FROM agents WHERE id = $1 LIMIT 1`,
    [DEFAULT_AGENT_ID],
  );
  return result.rows[0] ?? null;
}

function deriveChatTitleFallback(userMessage: string, assistantMessage: string): string {
  const userFirst = firstSentence(userMessage);
  if (userFirst) {
    return truncate(userFirst, 80);
  }
  const assistantFirst = firstSentence(assistantMessage);
  if (assistantFirst) {
    return truncate(assistantFirst, 80);
  }
  return "New chat";
}

function firstSentence(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) return "";
  const match = normalized.match(/(.+?[.!?])(?:\s|$)/);
  return match?.[1]?.trim() ?? normalized;
}

function truncate(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength - 3).trimEnd()}...`;
}
