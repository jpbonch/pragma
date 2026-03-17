export type ConversationMode = "chat" | "plan" | "execute";

export type HarnessId = "codex" | "claude_code";
export type ReasoningEffort = "low" | "medium" | "high" | "extra_high";

export const TASK_STATUS_VALUES = [
  "planning",
  "planned",
  "queued",
  "orchestrating",
  "running",
  "waiting_for_recipient",
  "waiting_for_question_response",
  "waiting_for_help_response",
  "pending_review",
  "needs_fix",
  "completed",
  "failed",
  "cancelled",
] as const;

export type TaskStatus = (typeof TASK_STATUS_VALUES)[number];

const TASK_STATUS_SET = new Set<string>(TASK_STATUS_VALUES);

export function isTaskStatus(value: unknown): value is TaskStatus {
  return typeof value === "string" && TASK_STATUS_SET.has(value);
}

export type ConversationStatus = "open" | "closed";

export type ConversationThread = {
  id: string;
  mode: ConversationMode;
  status: ConversationStatus;
  harness: HarnessId;
  model_label: string;
  model_id: string;
  harness_session_id: string | null;
  task_id: string | null;
  source_thread_id: string | null;
  chat_title?: string | null;
  chat_preview?: string | null;
  chat_last_message_at?: string | null;
  created_at: string;
  updated_at: string;
};

export type ChatThreadListItem = {
  id: string;
  chat_title: string | null;
  chat_preview: string | null;
  status: ConversationStatus;
  updated_at: string;
  chat_last_message_at: string | null;
  latest_turn_status: "running" | "completed" | "failed" | null;
};

export type OpenPlanThreadListItem = {
  id: string;
  status: ConversationStatus;
  created_at: string;
  updated_at: string;
  task_id: string | null;
  latest_plan_assistant_message: string | null;
  first_user_message: string | null;
  has_completed_plan_turn: boolean;
  latest_turn_status: "running" | "completed" | "failed" | null;
  task_status: string | null;
};

export type ConversationTurn = {
  id: string;
  thread_id: string;
  mode: ConversationMode;
  user_message: string;
  assistant_message: string | null;
  reasoning_effort: ReasoningEffort | null;
  requested_recipient_agent_id: string | null;
  selected_agent_id: string | null;
  orchestrator_agent_id: string | null;
  worker_session_id: string | null;
  selection_status: "auto_selected" | "manual_selected" | "recipient_required" | "invalid" | null;
  status: "running" | "completed" | "failed";
  created_at: string;
  completed_at: string | null;
};

export type ConversationMessage = {
  id: string;
  thread_id: string;
  turn_id: string | null;
  role: "user" | "assistant" | "system";
  content: string;
  created_at: string;
};

export type ConversationEvent = {
  id: string;
  seq?: number;
  thread_id: string;
  turn_id: string | null;
  event_name: string;
  payload_json: string;
  created_at: string;
};

export type AdapterEvent =
  | { type: "assistant_text"; delta: string }
  | { type: "tool_event"; name: string; payload: Record<string, unknown> | string | null };

export type AdapterSendTurnInput = {
  prompt: string;
  modelId: string;
  sessionId: string | null;
  cwd: string;
  env?: Record<string, string>;
  mode: ConversationMode;
  reasoningEffort?: ReasoningEffort;
  onEvent: (event: AdapterEvent) => void | Promise<void>;
  abortSignal?: AbortSignal;
};

export type AdapterSendTurnResult = {
  sessionId: string;
  finalText: string;
  rawSummary?: string;
  aborted?: boolean;
};

export interface ConversationAdapter {
  sendTurn(input: AdapterSendTurnInput): Promise<AdapterSendTurnResult>;
}
