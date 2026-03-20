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
  pragmaCliCommand = "pragma-so",
  options: {
    planCandidates?: WorkerCandidate[];
    workspaceIsEmpty?: boolean;
    workspaceDir?: string;
    codeRepos?: string[];
    conversationHistory?: Array<{ role: string; content: string }>;
  } = {},
): string {
  const cleanMessage = message.trim();
  const reasoningLine = formatReasoningInstruction(reasoningEffort);
  const cli = pragmaCliCommand.trim() || "pragma-so";

  if (mode === "chat") {
    const chatParts = [
      "You are a pragmatic software engineering assistant.",
      "Chat mode is read-only. You may read files, search code, and run read-only shell commands, but you must not create, edit, or delete any files.",
    ];

    const wsDir = options.workspaceDir?.trim();
    if (wsDir) {
      chatParts.push(`Your working directory is \`${wsDir}\`. Stay within this directory.`);
      const repos = options.codeRepos;
      if (repos && repos.length > 0) {
        chatParts.push(`Repos under code/: ${repos.join(", ")}`);
      }
    }

    const dbQueryCommand = `${cli} db-query --sql "<SELECT statement>"`;
    chatParts.push(
      "To inspect workspace database state (tasks, threads, messages, events), run read-only SQL queries:",
      dbQueryCommand,
      "Key tables: tasks, conversation_threads, conversation_turns, conversation_messages, conversation_events, agents.",
    );

    chatParts.push(
      "Use exploratory probing when useful to understand existing code, context, and constraints before acting.",
      "Answer clearly and concisely.",
      reasoningLine,
    );

    const historyBlock = options.conversationHistory
      ? buildConversationHistoryBlock(options.conversationHistory)
      : "";
    if (historyBlock) {
      chatParts.push(historyBlock);
    }

    chatParts.push("User message:", cleanMessage);

    return chatParts.join("\n\n");
  }

  if (mode === "plan") {
    const planProposeCommand = `${cli} task plan-propose --task '<JSON>' [--task '<JSON>' ...]`;
    const listAgentsCommand = `${cli} list-agents`;
    const askQuestionCommand = `${cli} task ask-question --question "<question>" [--details "<optional context>"] [--option "<choice>" --option "<choice>" ...]`;
    const dbQueryCommand = `${cli} db-query --sql "<SELECT statement>"`;
    const candidates = Array.isArray(options.planCandidates) ? options.planCandidates : [];
    const candidateLines = candidates.map((candidate, index) => {
      const desc = candidate.description ? `; description=${candidate.description}` : "";
      return `${index + 1}. id=${candidate.id}; name=${candidate.name}${desc}; harness=${candidate.harness}; model=${candidate.modelLabel}`;
    });
    const workspaceInstruction = options.workspaceIsEmpty
      ? "Workspace appears empty. Skip exploratory probing and immediately produce the plan and proposal."
      : "Use tools for read-only inspection and exploratory context gathering before finalizing the plan.";

    return [
      "You are planning work for implementation agents.",
      "Plan mode is planning-only.",
      workspaceInstruction,
      "The `context/` directory in the workspace may contain markdown knowledge files written by previous agents. Check it for relevant prior context before planning.",
      "Do not execute implementation work and do not modify files.",
      `Use this Pragma CLI command prefix: ${cli}`,
      "",
      "## Step 1: Evaluate whether clarification is needed",
      "Before producing any plan, assess the user's request for ambiguities, missing context, or decisions that could reasonably go multiple ways.",
      "If the request is unclear, underspecified, or you are uncertain about the right approach, ask the user a clarifying question:",
      askQuestionCommand,
      "Use --option flags when there are a small number of concrete choices (2-5). Omit --option for open-ended questions.",
      "After asking a question, STOP immediately. Do not produce a plan. Do not submit a proposal. Output only the question and nothing else. Wait for the user to respond.",
      "To inspect workspace state (tasks, events, threads, messages), run read-only SQL queries:",
      dbQueryCommand,
      "Key tables: tasks (id, title, status, assigned_to, plan), conversation_threads (id, mode, task_id), conversation_turns (id, thread_id, mode, status), conversation_messages (id, thread_id, role, content), conversation_events (id, thread_id, event_name, payload), agents (id, name, status, harness).",
      "",
      "## Step 2: Produce the plan (only when requirements are clear)",
      "When the request is unambiguous and you have enough information, return a concrete, decision-complete plan in plain language.",
      "Your full response will be stored as the plan and passed to the implementation agent(s).",
      "If you need to inspect available agents, run:",
      listAgentsCommand,
      "Available worker candidates (use one of these ids for `recipient`):",
      candidateLines.length > 0 ? candidateLines.join("\n") : "(none available)",
      "",
      "## Step 3: Submit the plan proposal",
      "After producing the plan, submit a structured proposal with tasks using this CLI command:",
      planProposeCommand,
      "Each --task flag takes a JSON object with:",
      '- "title": short task name',
      '- "prompt": the full implementation prompt for that task',
      '- "recipient": agent id from the candidate list above',
      "",
      "For multi-step work, submit multiple --task flags. Tasks execute in sequence — each starts when the previous is ready for review.",
      "For single tasks, submit one --task flag.",
      "You MUST call this command exactly once, after writing the plan.",
      "",
      "Rules:",
      "- Choose valid worker ids from the candidate list.",
      "- In the execution plan, direct task-specific deliverables (reports/docs/assets) to `outputs/$PRAGMA_TASK_ID/`, not `context/`.",
      "- Reserve `context/` only for enduring project knowledge that should outlive a single task.",
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
  const cli = input.pragmaCliCommand?.trim() || "pragma-so";
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
  contextIndex?: string;
}): string {
  const agentFile = input.workerAgentFile.trim();
  const task = input.task.trim();
  const reasoningLine = formatReasoningInstruction(input.reasoningEffort ?? "medium");
  const cli = input.pragmaCliCommand?.trim() || "pragma-so";
  const preferredCodePath = input.preferredCodePath?.trim() || "";
  const taskWorkspaceDir = input.taskWorkspaceDir?.trim() || "";
  const askQuestionCommand = `${cli} task ask-question --question "<question>" [--details "<optional context>"] [--option "<choice>" --option "<choice>" ...]`;
  const requestHelpCommand = `${cli} task request-help --summary "<short summary>" [--details "<optional context>"]`;
  const submitTestsCommand = `${cli} task submit-test-commands --command "<test command>" --cwd "<run directory>" [--name "<button label>"]`;
  const submitTestingConfigCommand = `${cli} task submit-testing-config --config '<JSON>'`;
  const dbQueryCommand = `${cli} db-query --sql "<SELECT statement>"`;
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
    "- NEVER read, edit, or write files outside the active task workspace root. Before every file edit, verify the absolute path starts with the workspace root above. If a search tool returns a path outside the workspace root, find the equivalent file under the workspace root instead — do not edit the external path.",
    codePathPolicyLine,
    "- Put non-code artifacts (docs, reports, generated assets) under `outputs/$PRAGMA_TASK_ID/`.",
    "- Do not place source code files at workspace root.",
    "Git workflow: You are working in an isolated git worktree on a task branch. Do not run git commit, push, or checkout. Your file changes are automatically committed and merged when the task is approved. Subdirectories under code/ may be independent git repos — run git commands inside them, not at the workspace root.",
    "Before making changes, check if the project has uninstalled dependencies (e.g. missing node_modules/, .venv/, vendor/, etc.) and install them using the appropriate package manager.",
    "If you need clarification from the human, run:",
    askQuestionCommand,
    "Use --option flags when there are a small number of concrete choices (2-5). Omit --option for open-ended questions.",
    "If you are blocked and need human help, run:",
    requestHelpCommand,
    "If you changed code, submit at least one runnable validation command for the task window.",
    `For richer testing UIs with multiple processes and panels, use \`submit-testing-config\`:`,
    submitTestingConfigCommand,
    `The config JSON has: \`processes\` (array of {name, command, cwd?, ready_pattern?}) and \`panels\` (array of panel objects). Panel types: \`web-preview\` ({type, title, process, path?, devices?}), \`api-tester\` ({type, title, process, endpoints: [{method, path, description?, body?, headers?}]}), \`terminal\` ({type, title, command, cwd?}), \`log-viewer\` ({type, title, process}). Optional: \`setup\` (array of setup commands), \`layout\` ("tabs"|"grid").`,
    `Example: \`--config '{"processes":[{"name":"server","command":"npm run dev","cwd":"code/my-app","ready_pattern":"ready on"}],"panels":[{"type":"web-preview","title":"App","process":"server"}]}'\``,
    `Fallback: for simple single-command cases, use:`,
    "Include the exact run directory for each command (for example: `--cwd \"code/default/my-app\"`):",
    submitTestsCommand,
    "Submit only commands the agent cannot fully validate by itself (for example interactive app/service run commands for human verification).",
    "Do not submit lint/typecheck/build/test commands to the task window.",
    "For app tasks, the first submitted command must run the app/service (for example dev/start script with explicit host/port).",
    "Provide only commands the human can run safely in this workspace.",
    "After either CLI escalation command, stop doing further work.",
    "Do not ask for clarification/help only in plain text without calling the CLI.",
    "To inspect workspace state (tasks, events, conversation history), run read-only SQL queries:",
    dbQueryCommand,
    reasoningLine,
    "Shared context: the `context/` directory contains markdown knowledge files that help agents understand the project.",
    "Context files should describe **enduring project knowledge** — things that are true about the codebase regardless of any single task. Good examples: overall architecture, how modules connect, deployment setup, testing conventions, non-obvious constraints. Bad examples: what a specific task changed, CSS values, implementation details that are obvious from reading the code. If a future agent could learn it in 30 seconds by reading the relevant file, it does not belong in context. Only create or update context files when you have genuine project-level insight to add. Most tasks should NOT produce context files.",
    input.contextIndex ? `Current context files:\n${input.contextIndex}` : "(No context files yet.)",
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

const MAX_HISTORY_CHARS = 50_000;
const MAX_SINGLE_MESSAGE_CHARS = 2_000;

export function buildConversationHistoryBlock(
  messages: Array<{ role: string; content: string }>,
): string {
  if (messages.length === 0) return "";

  const lines: string[] = [];
  let totalChars = 0;

  for (const msg of messages) {
    const label = msg.role === "assistant" ? "Assistant" : "User";
    let content = msg.content.trim();
    if (content.length > MAX_SINGLE_MESSAGE_CHARS) {
      content = content.slice(0, MAX_SINGLE_MESSAGE_CHARS) + "... [truncated]";
    }
    const line = `${label}: ${content}`;
    if (totalChars + line.length > MAX_HISTORY_CHARS) break;
    lines.push(line);
    totalChars += line.length;
  }

  if (lines.length === 0) return "";

  return [
    "<conversation_history>",
    ...lines,
    "</conversation_history>",
    "",
    "Continue this conversation. The user's new message follows.",
  ].join("\n");
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
