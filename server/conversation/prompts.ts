import { join } from "node:path";
import type { ReasoningEffort } from "./types";

type WorkerCandidate = {
  id: string;
  name: string;
  description: string | null;
  harness: string;
  modelLabel: string;
};

export function buildPrompt(
  mode: "chat" | "plan" | "execute",
  message: string,
  reasoningEffort: ReasoningEffort = "medium",
  pragmaCliCommand = "pragma",
  options: {
    planCandidates?: WorkerCandidate[];
    workspaceIsEmpty?: boolean;
  } = {},
): string {
  const cleanMessage = message.trim();
  const reasoningLine = formatReasoningInstruction(reasoningEffort);
  const cli = pragmaCliCommand.trim() || "pragma";

  if (mode === "chat") {
    return [
      "You are a pragmatic software engineering assistant.",
      "Chat mode is read-only. You may read files, search code, and run read-only shell commands, but you must not create, edit, or delete any files.",
      "Use exploratory probing when useful to understand existing code, context, and constraints before acting.",
      "Answer clearly and concisely.",
      reasoningLine,
      "User message:",
      cleanMessage,
    ].join("\n\n");
  }

  if (mode === "plan") {
    const planRecipientCommand = `${cli} task plan-select-recipient --agent-id "<candidate_id>" --reason "<one sentence reason>"`;
    const listAgentsCommand = `${cli} list-agents`;
    const askQuestionCommand = `${cli} task ask-question --question "<question>" [--details "<optional context>"]`;
    const candidates = Array.isArray(options.planCandidates) ? options.planCandidates : [];
    const candidateLines = candidates.map((candidate, index) => {
      const desc = candidate.description ? `; description=${candidate.description}` : "";
      return `${index + 1}. id=${candidate.id}; name=${candidate.name}${desc}; harness=${candidate.harness}; model=${candidate.modelLabel}`;
    });
    const workspaceInstruction = options.workspaceIsEmpty
      ? "Workspace appears empty. Skip exploratory probing and immediately produce the plan and recipient selection."
      : "Use tools for read-only inspection and exploratory context gathering before finalizing the plan.";

    return [
      "You are planning work for an implementation agent.",
      "Plan mode is planning-only.",
      workspaceInstruction,
      "Do not execute implementation work and do not modify files.",
      "Return a concrete, decision-complete plan in plain language as your response.",
      "Your full response will be stored as the plan and passed to the implementation agent.",
      `Use this Pragma CLI command prefix: ${cli}`,
      "If you need clarification before finalizing the plan, ask the user:",
      askQuestionCommand,
      "After asking, stop further work until the user responds.",
      "If you need to inspect available agents, run:",
      listAgentsCommand,
      "Available worker candidates (use one of these ids for `--agent-id`):",
      candidateLines.length > 0 ? candidateLines.join("\n") : "(none available)",
      "Persist the selected implementation recipient by calling exactly one CLI command:",
      planRecipientCommand,
      "Rules:",
      "- Use exactly one recipient selection command and choose a valid worker id.",
      "- Recipient reason must be one sentence.",
      "- Write the plan as your natural response with clear steps.",
      reasoningLine,
      "User request:",
      cleanMessage,
    ].join("\n\n");
  }

  return [
    "You are executing a software task end-to-end.",
    "Begin with exploratory probing as needed so you understand existing structure, context, and constraints.",
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
  pragmaCliCommand?: string;
  skills?: Array<{ name: string; description: string | null }>;
}): string {
  const forced = input.forcedRecipientAgentId?.trim() || "";
  const reasoningLine = formatReasoningInstruction(input.reasoningEffort ?? "medium");
  const cli = input.pragmaCliCommand?.trim() || "pragma";
  const selectRecipientCommand = `${cli} task select-recipient --agent-id <candidate_id> --reason "<one sentence reason>"`;
  const candidateLines = input.candidates.map((candidate, index) => {
    const desc = candidate.description ? `; description=${candidate.description}` : "";
    return `${index + 1}. id=${candidate.id}; name=${candidate.name}${desc}; harness=${candidate.harness}; model=${candidate.modelLabel}`;
  });

  const parts = [
    "You are an Orchestrator.",
    "Your only task is to pick the best worker agent for the task below.",
    "Do not execute the task.",
    `Use this Pragma CLI command prefix: ${cli}`,
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
  ];

  const skillIndex = formatSkillIndex(input.skills, cli);
  if (skillIndex) {
    parts.push(skillIndex);
  }

  return parts.join("\n\n");
}

export function buildWorkerPrompt(input: {
  task: string;
  workerName: string;
  workerAgentFile: string;
  reasoningEffort?: ReasoningEffort;
  pragmaCliCommand?: string;
  preferredCodePath?: string | null;
  taskWorkspaceDir?: string;
  skills?: Array<{ name: string; description: string | null }>;
}): string {
  const agentFile = input.workerAgentFile.trim();
  const task = input.task.trim();
  const reasoningLine = formatReasoningInstruction(input.reasoningEffort ?? "medium");
  const cli = input.pragmaCliCommand?.trim() || "pragma";
  const preferredCodePath = input.preferredCodePath?.trim() || "";
  const taskWorkspaceDir = input.taskWorkspaceDir?.trim() || "";
  const askQuestionCommand = `${cli} task ask-question --question "<question>" [--details "<optional context>"]`;
  const requestHelpCommand = `${cli} task request-help --summary "<short summary>" [--details "<optional context>"]`;
  const submitTestsCommand = `${cli} task submit-test-commands --command "<test command>" --cwd "<run directory>" [--name "<button label>"]`;
  const codePathPolicyLine = preferredCodePath
    ? taskWorkspaceDir
      ? `- Put code/source changes under \`${join(taskWorkspaceDir, preferredCodePath)}/\` (relative: \`${preferredCodePath}/\`) unless the task explicitly targets another repo inside this task workspace.`
      : `- Put code/source changes under \`${preferredCodePath}/\` unless the task explicitly targets another repo.`
    : taskWorkspaceDir
      ? `- Put code/source changes under \`${join(taskWorkspaceDir, "code")}/\`.`
      : "- Put code/source changes under `code/`.";
  const workspaceBoundaryLine = taskWorkspaceDir
    ? `- Active task workspace root (write boundary): \`${taskWorkspaceDir}/\`.`
    : "- Active task workspace root (write boundary): current working directory.";

  const parts = [
    `You are ${input.workerName}.`,
    "Follow your agent instructions exactly, then execute the task.",
    "Use exploratory probing as needed to gather context before making changes.",
    `Use this Pragma CLI command prefix: ${cli}`,
    "Path policy:",
    workspaceBoundaryLine,
    "- Never write outside the active task workspace root; runtime guard blocks writes outside the task worktree.",
    codePathPolicyLine,
    "- Put non-code artifacts (docs, reports, generated assets) under `outputs/$PRAGMA_TASK_ID/`.",
    "- Do not place source code files at workspace root.",
    "Git workflow: You are working in an isolated git worktree on a task branch. Do not run git commit, push, or checkout. Your file changes are automatically committed and merged when the task is approved. Subdirectories under code/ may be independent git repos — run git commands inside them, not at the workspace root.",
    "Before making changes, check if the project has uninstalled dependencies (e.g. missing node_modules/, .venv/, vendor/, etc.) and install them using the appropriate package manager.",
    "If you need clarification from the human, run:",
    askQuestionCommand,
    "If you are blocked and need human help, run:",
    requestHelpCommand,
    "If you changed code, submit at least one runnable validation command for the task window.",
    "Include the exact run directory for each command (for example: `--cwd \"code/default/my-app\"`):",
    submitTestsCommand,
    "Submit only commands the agent cannot fully validate by itself (for example interactive app/service run commands for human verification).",
    "Do not submit lint/typecheck/build/test commands to the task window.",
    "For app tasks, the first submitted command must run the app/service (for example dev/start script with explicit host/port).",
    "Provide only commands the human can run safely in this workspace.",
    "After either CLI escalation command, stop doing further work.",
    "Do not ask for clarification/help only in plain text without calling the CLI.",
    reasoningLine,
    "Agent instructions:",
    agentFile || "(No agent file provided. Use pragmatic software engineering judgement.)",
  ];

  const skillIndex = formatSkillIndex(input.skills, cli);
  if (skillIndex) {
    parts.push(skillIndex);
  }

  parts.push("Task:", task, "Return a concise final result.");

  return parts.join("\n\n");
}

function formatSkillIndex(
  skills: Array<{ name: string; description: string | null }> | undefined,
  cli: string,
): string | null {
  if (!skills || skills.length === 0) {
    return null;
  }

  const lines = skills.map((s) => `- ${s.name}: ${s.description || "(no description)"}`);
  return [
    `Available skills (use \`${cli} agent get-skill --name "<name>"\` to read full instructions):`,
    ...lines,
  ].join("\n");
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
