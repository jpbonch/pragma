import type { PGlite } from "@electric-sql/pglite";
import type { TaskStatus } from "../conversation/types";

export type TaskListRow = {
  id: string;
  title: string;
  status: TaskStatus;
  assigned_to: string | null;
  output_dir: string | null;
  session_id: string | null;
  created_at: string;
  completed_at: string | null;
  followup_task_id: string | null;
  predecessor_task_id: string | null;
  thread_id: string | null;
  failure_payload_json: string | null;
};

export type TaskDetailRow = {
  id: string;
  title: string;
  status: TaskStatus;
  assigned_to: string | null;
  merge_retry_count: number | null;
  git_state_json: string | null;
  predecessor_task_id: string | null;
  followup_task_id: string | null;
};

export async function listTasks(
  db: PGlite,
  input: { status?: string; limit: number },
): Promise<TaskListRow[]> {
  const params: Array<string | number> = [input.limit];
  let query = `
SELECT j.id,
       j.title,
       j.status,
       j.assigned_to,
       j.output_dir,
       j.session_id,
       j.created_at,
       j.completed_at,
       j.followup_task_id,
       j.predecessor_task_id,
       latest_thread.id AS thread_id,
       latest_error.payload_json AS failure_payload_json
FROM tasks j
LEFT JOIN LATERAL (
  SELECT ct.id
  FROM conversation_threads ct
  WHERE ct.task_id = j.id
  ORDER BY ct.created_at DESC
  LIMIT 1
) AS latest_thread ON TRUE
LEFT JOIN LATERAL (
  SELECT ce.payload_json
  FROM conversation_events ce
  WHERE ce.thread_id = latest_thread.id
    AND ce.event_name = 'error'
  ORDER BY ce.created_at DESC
  LIMIT 1
) AS latest_error ON TRUE
`;

  if (input.status) {
    query += "WHERE status = $2\n";
    params.push(input.status);
  }

  query += "ORDER BY created_at DESC\nLIMIT $1";

  const result = await db.query<TaskListRow>(query, params);
  return result.rows;
}

export async function getTaskDetail(db: PGlite, taskId: string): Promise<TaskDetailRow | null> {
  const result = await db.query<TaskDetailRow>(
    `SELECT id, title, status, assigned_to, merge_retry_count,
            git_state_json, predecessor_task_id, followup_task_id
     FROM tasks WHERE id = $1 LIMIT 1`,
    [taskId],
  );
  return result.rows[0] ?? null;
}

export async function getTaskStatus(
  db: PGlite,
  taskId: string,
): Promise<{ id: string; status: TaskStatus } | null> {
  const result = await db.query<{ id: string; status: TaskStatus }>(
    `SELECT id, status FROM tasks WHERE id = $1 LIMIT 1`,
    [taskId],
  );
  return result.rows[0] ?? null;
}

export async function getTaskStatusAndAssignment(
  db: PGlite,
  taskId: string,
): Promise<{ id: string; status: TaskStatus; assigned_to: string | null } | null> {
  const result = await db.query<{ id: string; status: TaskStatus; assigned_to: string | null }>(
    `SELECT id, status, assigned_to FROM tasks WHERE id = $1 LIMIT 1`,
    [taskId],
  );
  return result.rows[0] ?? null;
}

export async function getTaskWithTestCommands(
  db: PGlite,
  taskId: string,
): Promise<{ id: string; status: TaskStatus; assigned_to: string | null; test_commands_json: string | null } | null> {
  const result = await db.query<{
    id: string;
    status: TaskStatus;
    assigned_to: string | null;
    test_commands_json: string | null;
  }>(
    `SELECT id, status, assigned_to, test_commands_json
     FROM tasks WHERE id = $1 LIMIT 1`,
    [taskId],
  );
  return result.rows[0] ?? null;
}

export async function getTaskChangesInfo(
  db: PGlite,
  taskId: string,
): Promise<{ id: string; status: string; git_state_json: string | null; changes_diff: string | null } | null> {
  const result = await db.query<{
    id: string;
    status: string;
    git_state_json: string | null;
    changes_diff: string | null;
  }>(
    `SELECT id, status, git_state_json, changes_diff
     FROM tasks WHERE id = $1 LIMIT 1`,
    [taskId],
  );
  return result.rows[0] ?? null;
}

export async function getTaskPlan(db: PGlite, taskId: string): Promise<string | null> {
  const result = await db.query<{ plan: string | null }>(
    `SELECT plan FROM tasks WHERE id = $1 LIMIT 1`,
    [taskId],
  );
  return result.rows[0]?.plan?.trim() || null;
}

export async function getTaskTestCommands(
  db: PGlite,
  taskId: string,
): Promise<{ id: string; test_commands_json: string | null } | null> {
  const result = await db.query<{ id: string; test_commands_json: string | null }>(
    `SELECT id, test_commands_json FROM tasks WHERE id = $1 LIMIT 1`,
    [taskId],
  );
  return result.rows[0] ?? null;
}

export async function getTaskOutputDir(
  db: PGlite,
  taskId: string,
): Promise<{ id: string; output_dir: string | null } | null> {
  const result = await db.query<{ id: string; output_dir: string | null }>(
    `SELECT id, output_dir FROM tasks WHERE id = $1 LIMIT 1`,
    [taskId],
  );
  return result.rows[0] ?? null;
}

export async function insertTask(
  db: PGlite,
  input: {
    id: string;
    title: string;
    status: TaskStatus;
    assigned_to: string | null;
    output_dir: string | null;
    session_id: string | null;
    plan?: string | null;
    predecessor_task_id?: string | null;
  },
): Promise<void> {
  if (input.predecessor_task_id) {
    await db.query(
      `INSERT INTO tasks (id, title, status, assigned_to, output_dir, session_id, plan, predecessor_task_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [input.id, input.title, input.status, input.assigned_to, input.output_dir, input.session_id, input.plan ?? null, input.predecessor_task_id],
    );
  } else {
    await db.query(
      `INSERT INTO tasks (id, title, status, assigned_to, output_dir, session_id, plan)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [input.id, input.title, input.status, input.assigned_to, input.output_dir, input.session_id, input.plan ?? null],
    );
  }
}

export async function updateTaskStatus(
  db: PGlite,
  taskId: string,
  status: TaskStatus | string,
  opts?: { completedAt?: boolean; mergeRetryCount?: number; outputDir?: string; pushAfterMerge?: boolean },
): Promise<void> {
  const sets: string[] = [`status = $2`];
  const params: unknown[] = [taskId, status];
  let idx = 3;

  if (opts?.completedAt) {
    sets.push(`completed_at = CURRENT_TIMESTAMP`);
  }
  if (opts?.completedAt === false) {
    sets.push(`completed_at = NULL`);
  }
  if (opts?.mergeRetryCount !== undefined) {
    sets.push(`merge_retry_count = $${idx++}`);
    params.push(opts.mergeRetryCount);
  }
  if (opts?.outputDir !== undefined) {
    sets.push(`output_dir = $${idx++}`);
    params.push(opts.outputDir);
  }
  if (opts?.pushAfterMerge !== undefined) {
    sets.push(`push_after_merge = $${idx++}`);
    params.push(opts.pushAfterMerge);
  }

  await db.query(`UPDATE tasks SET ${sets.join(", ")} WHERE id = $1`, params);
}

export async function updateTaskTestCommandsJson(
  db: PGlite,
  taskId: string,
  json: string,
): Promise<void> {
  await db.query(`UPDATE tasks SET test_commands_json = $2 WHERE id = $1`, [taskId, json]);
}

export async function updateTaskAssignment(
  db: PGlite,
  taskId: string,
  assignedTo: string,
): Promise<void> {
  await db.query(`UPDATE tasks SET assigned_to = $2 WHERE id = $1`, [taskId, assignedTo]);
}

export async function setTaskFollowup(
  db: PGlite,
  parentTaskId: string,
  followupTaskId: string,
): Promise<void> {
  await db.query(`UPDATE tasks SET followup_task_id = $2 WHERE id = $1`, [parentTaskId, followupTaskId]);
}

export async function getTaskFollowupInfo(
  db: PGlite,
  taskId: string,
): Promise<{ id: string; status: TaskStatus; followup_task_id: string | null } | null> {
  const result = await db.query<{
    id: string;
    status: TaskStatus;
    followup_task_id: string | null;
  }>(
    `SELECT id, status, followup_task_id FROM tasks WHERE id = $1 LIMIT 1`,
    [taskId],
  );
  return result.rows[0] ?? null;
}

export async function getTaskCurrentStatus(
  db: PGlite,
  taskId: string,
): Promise<TaskStatus | null> {
  const result = await db.query<{ status: TaskStatus }>(
    `SELECT status FROM tasks WHERE id = $1 LIMIT 1`,
    [taskId],
  );
  return result.rows[0]?.status ?? null;
}

export async function getTaskPredecessorId(
  db: PGlite,
  taskId: string,
): Promise<string | null> {
  const result = await db.query<{ predecessor_task_id: string | null }>(
    `SELECT predecessor_task_id FROM tasks WHERE id = $1 LIMIT 1`,
    [taskId],
  );
  return result.rows[0]?.predecessor_task_id ?? null;
}

export async function updateTaskForPlanExecution(
  db: PGlite,
  taskId: string,
  status: string,
  assignedTo: string,
  plan: string,
  title?: string,
): Promise<void> {
  if (title) {
    await db.query(
      `UPDATE tasks SET status = $2, assigned_to = $3, plan = $4, title = $5 WHERE id = $1`,
      [taskId, status, assignedTo, plan, title],
    );
  } else {
    await db.query(
      `UPDATE tasks SET status = $2, assigned_to = $3, plan = $4 WHERE id = $1`,
      [taskId, status, assignedTo, plan],
    );
  }
}

export async function getStoredPlanRecipientForTurn(
  db: PGlite,
  turnId: string,
): Promise<string | null> {
  const result = await db.query<{ selected_agent_id: string | null }>(
    `SELECT selected_agent_id FROM conversation_turns WHERE id = $1 LIMIT 1`,
    [turnId],
  );
  return result.rows[0]?.selected_agent_id ?? null;
}

export async function updateTurnRecipient(
  db: PGlite,
  turnId: string,
  selectedAgentId: string,
): Promise<void> {
  await db.query(
    `UPDATE conversation_turns
     SET selected_agent_id = $2, selection_status = 'auto_selected'
     WHERE id = $1`,
    [turnId, selectedAgentId],
  );
}

export async function getTurnForPlanValidation(
  db: PGlite,
  turnId: string,
  threadId: string,
): Promise<{ id: string; thread_id: string; mode: string } | null> {
  const result = await db.query<{ id: string; thread_id: string; mode: string }>(
    `SELECT id, thread_id, mode
     FROM conversation_turns
     WHERE id = $1 AND thread_id = $2
     LIMIT 1`,
    [turnId, threadId],
  );
  return result.rows[0] ?? null;
}
