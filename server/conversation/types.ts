export type ConversationMode = "chat" | "plan" | "execute";

export type HarnessId = "codex" | "claude_code";
export type ReasoningEffort = "low" | "medium" | "high" | "extra_high";

export type ConversationStatus = "open" | "closed";

export type ConversationThread = {
  id: string;
  mode: ConversationMode;
  status: ConversationStatus;
  harness: HarnessId;
  model_label: string;
  model_id: string;
  harness_session_id: string | null;
  job_id: string | null;
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
};

export type ConversationTurn = {
  id: string;
  thread_id: string;
  mode: ConversationMode;
  user_message: string;
  assistant_message: string | null;
  plan_summary: string | null;
  reasoning_effort: ReasoningEffort | null;
  requested_recipient_agent_id: string | null;
  selected_agent_id: string | null;
  orchestrator_agent_id: string | null;
  worker_session_id: string | null;
  selection_status: "auto_selected" | "manual_selected" | "needs_input" | "invalid" | null;
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
  mode: ConversationMode;
  reasoningEffort?: ReasoningEffort;
  onEvent: (event: AdapterEvent) => void | Promise<void>;
};

export type AdapterSendTurnResult = {
  sessionId: string;
  finalText: string;
  rawSummary?: string;
};

export interface ConversationAdapter {
  sendTurn(input: AdapterSendTurnInput): Promise<AdapterSendTurnResult>;
}

export type PlanSummary = {
  title: string;
  summary: string;
  steps: string[];
};
