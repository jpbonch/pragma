import { SalmonError } from "../db";
import type { HarnessId } from "./types";

const MODEL_MAP: Record<HarnessId, Record<string, string>> = {
  claude_code: {
    "Opus 4.6": "opus",
    "Sonnet 4.6": "sonnet",
    "Haiku 4.5": "haiku",
  },
  codex: {
    "GPT-5": "gpt-5",
    "GPT-5.3-Codex": "gpt-5.3-codex",
  },
};

export function resolveModelId(harness: HarnessId, label: string): string {
  const mapping = MODEL_MAP[harness];
  const modelId = mapping?.[label];
  if (!modelId) {
    throw new SalmonError(
      "INVALID_MODEL",
      400,
      `Unknown model for harness ${harness}: ${label}`,
    );
  }
  return modelId;
}

export function modelOptionsByHarness(): Record<HarnessId, string[]> {
  return {
    claude_code: Object.keys(MODEL_MAP.claude_code),
    codex: Object.keys(MODEL_MAP.codex),
  };
}
