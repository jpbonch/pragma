import type { ReasoningEffort } from "./types";

type WorkerCandidate = {
  id: string;
  name: string;
  harness: string;
  modelLabel: string;
};

export function buildPrompt(
  mode: "chat" | "plan" | "execute",
  message: string,
  reasoningEffort: ReasoningEffort = "medium",
  salmonCliCommand = "salmon",
): string {
  const cleanMessage = message.trim();
  const reasoningLine = formatReasoningInstruction(reasoningEffort);
  const cli = salmonCliCommand.trim() || "salmon";

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
    const planSummaryCommand = `${cli} job plan-summary --title "<short title>" --summary "<1-2 sentence summary>" --step "<step 1>" --step "<step 2>"`;
    return [
      "You are planning work for an implementation agent.",
      "Plan mode is planning-only.",
      "You may use tools for read-only inspection and context gathering.",
      "Do not execute implementation work and do not modify files.",
      "Return a concrete, decision-complete plan in plain language.",
      `Use this Salmon CLI command prefix: ${cli}`,
      "Then persist structured plan data by calling exactly one CLI command:",
      planSummaryCommand,
      "Rules:",
      "- Use at least one --step flag and keep steps ordered.",
      "- Title and summary must be concise and specific.",
      "- Do not emit PLAN_SUMMARY_JSON tags.",
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
  salmonCliCommand?: string;
}): string {
  const forced = input.forcedRecipientAgentId?.trim() || "";
  const reasoningLine = formatReasoningInstruction(input.reasoningEffort ?? "medium");
  const cli = input.salmonCliCommand?.trim() || "salmon";
  const selectRecipientCommand = `${cli} job select-recipient --agent-id <candidate_id> --reason "<one sentence reason>"`;
  const candidateLines = input.candidates.map((candidate, index) => {
    return `${index + 1}. id=${candidate.id}; name=${candidate.name}; harness=${candidate.harness}; model=${candidate.modelLabel}`;
  });

  return [
    "You are an Orchestrator.",
    "Your only job is to pick the best worker agent for the task.",
    "Do not execute the task.",
    `Use this Salmon CLI command prefix: ${cli}`,
    "Call exactly one CLI command to persist the selected worker:",
    selectRecipientCommand,
    "Rules:",
    "- You MUST execute the command exactly once.",
    "- agent-id MUST be one of the listed candidate ids.",
    "- reason must be one sentence.",
    "- Do not output JSON tags or any RECIPIENT payload.",
    reasoningLine,
    forced
      ? `- A recipient was manually requested. You MUST choose this exact agent id: ${forced}`
      : "- If no candidate is suitable, still choose the closest match.",
    "Task:",
    input.task.trim(),
    "Candidate workers:",
    candidateLines.length > 0 ? candidateLines.join("\n") : "(none)",
    "After the command succeeds, return a concise plain-text confirmation.",
  ].join("\n\n");
}

export function buildWorkerPrompt(input: {
  task: string;
  workerName: string;
  workerAgentFile: string;
  reasoningEffort?: ReasoningEffort;
  salmonCliCommand?: string;
}): string {
  const agentFile = input.workerAgentFile.trim();
  const task = input.task.trim();
  const reasoningLine = formatReasoningInstruction(input.reasoningEffort ?? "medium");
  const cli = input.salmonCliCommand?.trim() || "salmon";
  const askQuestionCommand = `${cli} job ask-question --question "<question>" [--details "<optional context>"]`;
  const requestHelpCommand = `${cli} job request-help --summary "<short summary>" [--details "<optional context>"]`;

  return [
    `You are ${input.workerName}.`,
    "Follow your agent instructions exactly, then execute the task.",
    `Use this Salmon CLI command prefix: ${cli}`,
    "Path policy:",
    "- Put code/source changes under `code/`.",
    "- Put non-code artifacts (docs, reports, generated assets) under `outputs/$SALMON_JOB_ID/`.",
    "- Do not place source code files at workspace root.",
    "If you need clarification from the human, run:",
    askQuestionCommand,
    "If you are blocked and need human help, run:",
    requestHelpCommand,
    "After either CLI escalation command, stop doing further work.",
    "Do not ask for clarification/help only in plain text without calling the CLI.",
    reasoningLine,
    "Agent instructions:",
    agentFile || "(No agent file provided. Use pragmatic software engineering judgement.)",
    "Task:",
    task,
    "Return a concise final result.",
  ].join("\n\n");
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
