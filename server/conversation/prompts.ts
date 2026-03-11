import type { PlanSummary, ReasoningEffort } from "./types";

const PLAN_START = "<PLAN_SUMMARY_JSON>";
const PLAN_END = "</PLAN_SUMMARY_JSON>";
const RECIPIENT_START = "<RECIPIENT_JSON>";
const RECIPIENT_END = "</RECIPIENT_JSON>";

type WorkerCandidate = {
  id: string;
  name: string;
  harness: string;
  modelLabel: string;
};

export type ParsedRecipient = {
  agentId: string;
  reason: string;
};

export function buildPrompt(
  mode: "chat" | "plan" | "execute",
  message: string,
  reasoningEffort: ReasoningEffort = "medium",
): string {
  const cleanMessage = message.trim();
  const reasoningLine = formatReasoningInstruction(reasoningEffort);

  if (mode === "chat") {
    return [
      "You are a pragmatic software engineering assistant.",
      "Answer clearly and concisely.",
      reasoningLine,
      "User message:",
      cleanMessage,
    ].join("\n\n");
  }

  if (mode === "plan") {
    return [
      "You are planning work for an implementation agent.",
      "Return a concrete, decision-complete plan.",
      "After the human-readable plan, you MUST include one JSON object wrapped exactly in these tags:",
      `${PLAN_START}{\"title\":\"...\",\"summary\":\"...\",\"steps\":[\"...\"]}${PLAN_END}`,
      "Rules for JSON:",
      "- title: short title",
      "- summary: 1-2 sentence summary",
      "- steps: ordered list of implementation steps",
      reasoningLine,
      "User request:",
      cleanMessage,
    ].join("\n\n");
  }

  return [
    "You are executing a software task end-to-end.",
    "Use tools as needed and provide a concise final result.",
    reasoningLine,
    "Task:",
    cleanMessage,
  ].join("\n\n");
}

export function buildOrchestratorPrompt(input: {
  task: string;
  candidates: WorkerCandidate[];
  forcedRecipientAgentId?: string | null;
  reasoningEffort?: ReasoningEffort;
}): string {
  const forced = input.forcedRecipientAgentId?.trim() || "";
  const reasoningLine = formatReasoningInstruction(input.reasoningEffort ?? "medium");
  const candidateLines = input.candidates.map((candidate, index) => {
    return `${index + 1}. id=${candidate.id}; name=${candidate.name}; harness=${candidate.harness}; model=${candidate.modelLabel}`;
  });

  return [
    "You are an Orchestrator.",
    "Your only job is to pick the best worker agent for the task.",
    "Do not execute the task.",
    "Return a short rationale, then include exactly one JSON object wrapped in tags:",
    `${RECIPIENT_START}{\"agent_id\":\"...\",\"reason\":\"...\"}${RECIPIENT_END}`,
    "Rules:",
    "- agent_id MUST be one of the listed candidate ids.",
    "- reason must be one sentence.",
    reasoningLine,
    forced
      ? `- A recipient was manually requested. You MUST choose this exact agent id: ${forced}`
      : "- If no candidate is suitable, still choose the closest match.",
    "Task:",
    input.task.trim(),
    "Candidate workers:",
    candidateLines.length > 0 ? candidateLines.join("\n") : "(none)",
  ].join("\n\n");
}

export function parseOrchestratorRecipient(finalText: string): ParsedRecipient | null {
  const parsed = extractJsonBetweenTags<Record<string, unknown>>(
    finalText,
    RECIPIENT_START,
    RECIPIENT_END,
  );
  if (!parsed) {
    return null;
  }

  const agentId = typeof parsed.agent_id === "string" ? parsed.agent_id.trim() : "";
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim() : "";
  if (!agentId) {
    return null;
  }

  return {
    agentId,
    reason,
  };
}

export function buildWorkerPrompt(input: {
  task: string;
  workerName: string;
  workerAgentFile: string;
  reasoningEffort?: ReasoningEffort;
}): string {
  const agentFile = input.workerAgentFile.trim();
  const task = input.task.trim();
  const reasoningLine = formatReasoningInstruction(input.reasoningEffort ?? "medium");

  return [
    `You are ${input.workerName}.`,
    "Follow your agent instructions exactly, then execute the task.",
    reasoningLine,
    "Agent instructions:",
    agentFile || "(No agent file provided. Use pragmatic software engineering judgement.)",
    "Task:",
    task,
    "Return a concise final result.",
  ].join("\n\n");
}

export function parsePlanSummary(finalText: string): PlanSummary {
  const parsed = extractJsonBetweenTags<PlanSummary>(finalText, PLAN_START, PLAN_END);
  if (parsed && isPlanSummary(parsed)) {
    return normalizePlanSummary(parsed);
  }

  return {
    title: fallbackTitle(finalText),
    summary: fallbackSummary(finalText),
    steps: fallbackSteps(finalText),
  };
}

function extractJsonBetweenTags<T>(text: string, startTag: string, endTag: string): T | null {
  const start = text.indexOf(startTag);
  const end = text.indexOf(endTag);
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }

  const jsonText = text.slice(start + startTag.length, end).trim();
  if (!jsonText) {
    return null;
  }

  try {
    return JSON.parse(jsonText) as T;
  } catch {
    return null;
  }
}

function isPlanSummary(value: unknown): value is PlanSummary {
  if (typeof value !== "object" || value === null) {
    return false;
  }

  const data = value as Record<string, unknown>;
  return (
    typeof data.title === "string" &&
    typeof data.summary === "string" &&
    Array.isArray(data.steps) &&
    data.steps.every((step) => typeof step === "string")
  );
}

function normalizePlanSummary(summary: PlanSummary): PlanSummary {
  return {
    title: summary.title.trim() || "Execution Plan",
    summary: summary.summary.trim() || "Planned work.",
    steps: summary.steps.map((step) => step.trim()).filter(Boolean),
  };
}

function fallbackTitle(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((part) => part.trim())
    .find(Boolean);

  if (!line) {
    return "Execution Plan";
  }

  return line.length > 80 ? `${line.slice(0, 77)}...` : line;
}

function fallbackSummary(text: string): string {
  const collapsed = text.replace(/\s+/g, " ").trim();
  if (!collapsed) {
    return "No summary available.";
  }

  return collapsed.length > 220 ? `${collapsed.slice(0, 217)}...` : collapsed;
}

function fallbackSteps(text: string): string[] {
  const lines = text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+|^\d+\.\s+/.test(line))
    .map((line) => line.replace(/^[-*]\s+|^\d+\.\s+/, ""))
    .filter(Boolean);

  if (lines.length > 0) {
    return lines.slice(0, 8);
  }

  return [fallbackSummary(text)];
}

function formatReasoningInstruction(reasoningEffort: ReasoningEffort): string {
  if (reasoningEffort === "extra_high") {
    return "Reasoning effort: extra high. Think deeply, consider alternatives, and verify assumptions.";
  }
  if (reasoningEffort === "high") {
    return "Reasoning effort: high. Use thorough reasoning and check edge cases.";
  }
  if (reasoningEffort === "low") {
    return "Reasoning effort: low. Prefer fast, direct reasoning and concise output.";
  }
  return "Reasoning effort: medium. Balance depth and speed.";
}
