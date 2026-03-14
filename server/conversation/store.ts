import type { PGlite } from "@electric-sql/pglite";
import type {
  ChatThreadListItem,
  ConversationEvent,
  ConversationMessage,
  ConversationMode,
  ConversationThread,
  ConversationTurn,
  HarnessId,
  OpenPlanThreadListItem,
  ReasoningEffort,
} from "./types";

export async function ensureConversationSchema(db: PGlite): Promise<void> {
  await db.exec(`
CREATE TABLE IF NOT EXISTS conversation_threads (
  id VARCHAR(64) PRIMARY KEY,
  mode VARCHAR(16) NOT NULL,
  status VARCHAR(32) NOT NULL DEFAULT 'open',
  harness VARCHAR(32) NOT NULL,
  model_label VARCHAR(128) NOT NULL,
  model_id VARCHAR(128) NOT NULL,
  harness_session_id VARCHAR(255),
  task_id VARCHAR(64),
  source_thread_id VARCHAR(64),
  chat_title TEXT,
  chat_preview TEXT,
  chat_last_message_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversation_turns (
  id VARCHAR(64) PRIMARY KEY,
  thread_id VARCHAR(64) NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
  mode VARCHAR(16) NOT NULL,
  user_message TEXT NOT NULL,
  assistant_message TEXT,
  plan_summary TEXT,
  reasoning_effort VARCHAR(16),
  requested_recipient_agent_id VARCHAR(64),
  selected_agent_id VARCHAR(64),
  orchestrator_agent_id VARCHAR(64),
  worker_session_id VARCHAR(255),
  selection_status VARCHAR(32),
  status VARCHAR(32) NOT NULL DEFAULT 'running',
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  completed_at TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS conversation_messages (
  id VARCHAR(64) PRIMARY KEY,
  thread_id VARCHAR(64) NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
  turn_id VARCHAR(64) REFERENCES conversation_turns(id) ON DELETE SET NULL,
  role VARCHAR(16) NOT NULL,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS conversation_events (
  id VARCHAR(64) PRIMARY KEY,
  thread_id VARCHAR(64) NOT NULL REFERENCES conversation_threads(id) ON DELETE CASCADE,
  turn_id VARCHAR(64) REFERENCES conversation_turns(id) ON DELETE SET NULL,
  event_name VARCHAR(64) NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_conversation_turns_thread ON conversation_turns(thread_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_conversation_messages_thread ON conversation_messages(thread_id, created_at ASC);
CREATE INDEX IF NOT EXISTS idx_conversation_events_thread ON conversation_events(thread_id, created_at ASC);
`);

  await db.exec(`
CREATE INDEX IF NOT EXISTS idx_conversation_chat_mode_sort ON conversation_threads(mode, chat_last_message_at DESC, updated_at DESC);
`);
}

export async function createThread(
  db: PGlite,
  input: {
    id: string;
    mode: ConversationMode;
    harness: HarnessId;
    modelLabel: string;
    modelId: string;
    sourceThreadId?: string | null;
    taskId?: string | null;
  },
): Promise<void> {
  await db.query(
    `
INSERT INTO conversation_threads (
  id,
  mode,
  status,
  harness,
  model_label,
  model_id,
  source_thread_id,
  task_id
)
VALUES ($1, $2, 'open', $3, $4, $5, $6, $7)
`,
    [
      input.id,
      input.mode,
      input.harness,
      input.modelLabel,
      input.modelId,
      input.sourceThreadId ?? null,
      input.taskId ?? null,
    ],
  );
}

export async function getThreadById(
  db: PGlite,
  threadId: string,
): Promise<ConversationThread | null> {
  const result = await db.query<ConversationThread>(
    `
SELECT id,
       mode,
       status,
       harness,
       model_label,
       model_id,
       harness_session_id,
       task_id,
       source_thread_id,
       chat_title,
       chat_preview,
       chat_last_message_at,
       created_at,
       updated_at
FROM conversation_threads
WHERE id = $1
`,
    [threadId],
  );

  return result.rows[0] ?? null;
}

export async function listChatThreads(
  db: PGlite,
  input?: { limit?: number; cursor?: string | null },
): Promise<ChatThreadListItem[]> {
  const requested = input?.limit ?? 20;
  const limit = Math.max(1, Math.min(requested, 20));
  const cursor = input?.cursor?.trim() || null;

  const params: Array<string | number> = [limit];
  let query = `
SELECT id,
       chat_title,
       chat_preview,
       status,
       updated_at,
       chat_last_message_at
FROM conversation_threads
WHERE mode = 'chat'
`;

  if (cursor) {
    params.push(cursor);
    query += "  AND COALESCE(chat_last_message_at, updated_at) < $2::timestamptz\n";
  }

  query += `
ORDER BY chat_last_message_at DESC NULLS LAST, updated_at DESC
LIMIT $1
`;

  const result = await db.query<ChatThreadListItem>(query, params);
  return result.rows;
}

export async function listOpenPlanThreads(
  db: PGlite,
  input?: { limit?: number; cursor?: string | null },
): Promise<OpenPlanThreadListItem[]> {
  const requested = input?.limit ?? 20;
  const limit = Math.max(1, Math.min(requested, 20));
  const cursor = input?.cursor?.trim() || null;

  const params: Array<string | number> = [limit];
  let query = `
SELECT thread.id,
       thread.status,
       thread.created_at,
       thread.updated_at,
       latest_plan_turn.plan_summary AS latest_plan_summary,
       first_plan_turn.user_message AS first_user_message,
       (latest_plan_turn.plan_summary IS NOT NULL) AS has_completed_plan_turn,
       newest_turn.status AS latest_turn_status
FROM conversation_threads AS thread
LEFT JOIN LATERAL (
  SELECT plan_summary
  FROM conversation_turns
  WHERE thread_id = thread.id
    AND mode = 'plan'
    AND status = 'completed'
    AND plan_summary IS NOT NULL
    AND plan_summary <> ''
  ORDER BY created_at DESC
  LIMIT 1
) AS latest_plan_turn ON TRUE
LEFT JOIN LATERAL (
  SELECT user_message
  FROM conversation_turns
  WHERE thread_id = thread.id
    AND mode = 'plan'
  ORDER BY created_at ASC
  LIMIT 1
) AS first_plan_turn ON TRUE
LEFT JOIN LATERAL (
  SELECT status
  FROM conversation_turns
  WHERE thread_id = thread.id
    AND mode = 'plan'
  ORDER BY created_at DESC
  LIMIT 1
) AS newest_turn ON TRUE
WHERE thread.mode = 'plan'
  AND thread.status = 'open'
`;

  if (cursor) {
    params.push(cursor);
    query += "  AND thread.updated_at < $2::timestamptz\n";
  }

  query += `
ORDER BY thread.updated_at DESC
LIMIT $1
`;

  const result = await db.query<OpenPlanThreadListItem>(query, params);
  return result.rows;
}

export async function updateChatThreadMetadata(
  db: PGlite,
  input: {
    threadId: string;
    title?: string | null;
    preview: string | null;
    lastMessageAt?: string | null;
    force?: boolean;
  },
): Promise<void> {
  const titleSql = input.force
    ? `chat_title = CASE
                      WHEN $2::text IS NOT NULL AND $2::text <> ''
                        THEN $2::text
                      ELSE chat_title
                    END`
    : `chat_title = CASE
                      WHEN (chat_title IS NULL OR chat_title = '') AND $2::text IS NOT NULL AND $2::text <> ''
                        THEN $2::text
                      ELSE chat_title
                    END`;

  await db.query(
    `
UPDATE conversation_threads
SET ${titleSql},
    chat_preview = $3::text,
    chat_last_message_at = COALESCE($4::timestamptz, CURRENT_TIMESTAMP),
    updated_at = CURRENT_TIMESTAMP
WHERE id = $1
`,
    [input.threadId, input.title ?? null, input.preview ?? null, input.lastMessageAt ?? null],
  );
}

export async function updateThreadSession(
  db: PGlite,
  input: { threadId: string; sessionId: string },
): Promise<void> {
  await db.query(
    `
UPDATE conversation_threads
SET harness_session_id = $2,
    updated_at = CURRENT_TIMESTAMP
WHERE id = $1
`,
    [input.threadId, input.sessionId],
  );
}

export async function closeThread(db: PGlite, threadId: string): Promise<void> {
  await db.query(
    `
UPDATE conversation_threads
SET status = 'closed',
    updated_at = CURRENT_TIMESTAMP
WHERE id = $1
`,
    [threadId],
  );
}

export async function reopenThread(db: PGlite, threadId: string): Promise<void> {
  await db.query(
    `
UPDATE conversation_threads
SET status = 'open',
    updated_at = CURRENT_TIMESTAMP
WHERE id = $1
`,
    [threadId],
  );
}

export async function createTurn(
  db: PGlite,
  input: {
    id: string;
    threadId: string;
    mode: ConversationMode;
    userMessage: string;
    reasoningEffort?: ReasoningEffort | null;
    requestedRecipientAgentId?: string | null;
    selectedAgentId?: string | null;
    orchestratorAgentId?: string | null;
    workerSessionId?: string | null;
    selectionStatus?: "auto_selected" | "manual_selected" | "recipient_required" | "invalid" | null;
  },
): Promise<void> {
  await db.query(
    `
INSERT INTO conversation_turns (
  id,
  thread_id,
  mode,
  user_message,
  reasoning_effort,
  requested_recipient_agent_id,
  selected_agent_id,
  orchestrator_agent_id,
  worker_session_id,
  selection_status,
  status
)
VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'running')
`,
    [
      input.id,
      input.threadId,
      input.mode,
      input.userMessage,
      input.reasoningEffort ?? null,
      input.requestedRecipientAgentId ?? null,
      input.selectedAgentId ?? null,
      input.orchestratorAgentId ?? null,
      input.workerSessionId ?? null,
      input.selectionStatus ?? null,
    ],
  );
}

export async function completeTurn(
  db: PGlite,
  input: {
    turnId: string;
    assistantMessage: string;
    planSummary: string | null;
    selectedAgentId?: string | null;
    workerSessionId?: string | null;
    selectionStatus?: "auto_selected" | "manual_selected" | "recipient_required" | "invalid" | null;
  },
): Promise<void> {
  await db.query(
    `
UPDATE conversation_turns
SET assistant_message = $2,
    plan_summary = $3,
    selected_agent_id = COALESCE($4, selected_agent_id),
    worker_session_id = COALESCE($5, worker_session_id),
    selection_status = COALESCE($6, selection_status),
    status = 'completed',
    completed_at = CURRENT_TIMESTAMP
WHERE id = $1
`,
    [
      input.turnId,
      input.assistantMessage,
      input.planSummary,
      input.selectedAgentId ?? null,
      input.workerSessionId ?? null,
      input.selectionStatus ?? null,
    ],
  );
}

export async function failTurn(db: PGlite, turnId: string, message: string): Promise<void> {
  await db.query(
    `
UPDATE conversation_turns
SET assistant_message = COALESCE(assistant_message, $2),
    status = 'failed',
    completed_at = CURRENT_TIMESTAMP
WHERE id = $1
`,
    [turnId, message],
  );
}

export async function insertMessage(
  db: PGlite,
  input: {
    id: string;
    threadId: string;
    turnId: string | null;
    role: "user" | "assistant" | "system";
    content: string;
  },
): Promise<void> {
  await db.query(
    `
INSERT INTO conversation_messages (id, thread_id, turn_id, role, content)
VALUES ($1, $2, $3, $4, $5)
`,
    [input.id, input.threadId, input.turnId, input.role, input.content],
  );
}

export async function insertEvent(
  db: PGlite,
  input: {
    id: string;
    threadId: string;
    turnId: string | null;
    eventName: string;
    payload: unknown;
  },
): Promise<void> {
  await db.query(
    `
INSERT INTO conversation_events (id, thread_id, turn_id, event_name, payload_json)
VALUES ($1, $2, $3, $4, $5)
`,
    [input.id, input.threadId, input.turnId, input.eventName, JSON.stringify(input.payload ?? null)],
  );
}

export async function setThreadTaskId(db: PGlite, threadId: string, taskId: string): Promise<void> {
  await db.query(
    `
UPDATE conversation_threads
SET task_id = $2,
    updated_at = CURRENT_TIMESTAMP
WHERE id = $1
`,
    [threadId, taskId],
  );
}

export async function getThreadByTaskId(
  db: PGlite,
  taskId: string,
): Promise<ConversationThread | null> {
  const result = await db.query<ConversationThread>(
    `
SELECT id,
       mode,
       status,
       harness,
       model_label,
       model_id,
       harness_session_id,
       task_id,
       source_thread_id,
       chat_title,
       chat_preview,
       chat_last_message_at,
       created_at,
       updated_at
FROM conversation_threads
WHERE task_id = $1
ORDER BY created_at DESC
LIMIT 1
`,
    [taskId],
  );

  return result.rows[0] ?? null;
}

export async function getLatestCompletedPlanTurn(
  db: PGlite,
  threadId: string,
): Promise<ConversationTurn | null> {
  const result = await db.query<ConversationTurn>(
    `
SELECT id,
       thread_id,
       mode,
       user_message,
       assistant_message,
       plan_summary,
       reasoning_effort,
       requested_recipient_agent_id,
       selected_agent_id,
       orchestrator_agent_id,
       worker_session_id,
       selection_status,
       status,
       created_at,
       completed_at
FROM conversation_turns
WHERE thread_id = $1
  AND mode = 'plan'
  AND status = 'completed'
ORDER BY created_at DESC
LIMIT 1
`,
    [threadId],
  );

  return result.rows[0] ?? null;
}

export async function getLatestExecuteTurn(
  db: PGlite,
  threadId: string,
): Promise<ConversationTurn | null> {
  const result = await db.query<ConversationTurn>(
    `
SELECT id,
       thread_id,
       mode,
       user_message,
       assistant_message,
       plan_summary,
       reasoning_effort,
       requested_recipient_agent_id,
       selected_agent_id,
       orchestrator_agent_id,
       worker_session_id,
       selection_status,
       status,
       created_at,
       completed_at
FROM conversation_turns
WHERE thread_id = $1
  AND mode = 'execute'
ORDER BY created_at DESC
LIMIT 1
`,
    [threadId],
  );

  return result.rows[0] ?? null;
}

export async function getThreadWithDetails(
  db: PGlite,
  threadId: string,
): Promise<{
  thread: ConversationThread | null;
  turns: ConversationTurn[];
  messages: ConversationMessage[];
  events: ConversationEvent[];
}> {
  const thread = await getThreadById(db, threadId);

  const [turnsResult, messagesResult, eventsResult] = await Promise.all([
    db.query<ConversationTurn>(
      `
SELECT id,
       thread_id,
       mode,
       user_message,
       assistant_message,
       plan_summary,
       reasoning_effort,
       requested_recipient_agent_id,
       selected_agent_id,
       orchestrator_agent_id,
       worker_session_id,
       selection_status,
       status,
       created_at,
       completed_at
FROM conversation_turns
WHERE thread_id = $1
ORDER BY created_at ASC
`,
      [threadId],
    ),
    db.query<ConversationMessage>(
      `
SELECT id, thread_id, turn_id, role, content, created_at
FROM conversation_messages
WHERE thread_id = $1
ORDER BY created_at ASC
`,
      [threadId],
    ),
    db.query<ConversationEvent>(
      `
SELECT id, thread_id, turn_id, event_name, payload_json, created_at
FROM conversation_events
WHERE thread_id = $1
ORDER BY created_at ASC
`,
      [threadId],
    ),
  ]);

  return {
    thread,
    turns: turnsResult.rows,
    messages: messagesResult.rows,
    events: eventsResult.rows,
  };
}
