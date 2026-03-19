import type { PGlite } from "@electric-sql/pglite";
import type { HarnessId } from "../conversation/types";

export type AgentRow = {
  id: string;
  name: string;
  description: string | null;
  status: string;
  agent_file: string | null;
  emoji: string | null;
  harness: HarnessId;
  model_label: string;
  model_id: string;
};

export async function listAgents(db: PGlite): Promise<AgentRow[]> {
  const result = await db.query<AgentRow>(
    `SELECT id, name, description, status, agent_file, emoji, harness, model_label, model_id
     FROM agents ORDER BY name ASC`,
  );
  return result.rows;
}

export async function getAgentById(
  db: PGlite,
  id: string,
): Promise<{
  id: string;
  name: string;
  harness: HarnessId;
  model_label: string;
  model_id: string;
  agent_file: string | null;
} | null> {
  const result = await db.query<{
    id: string;
    name: string;
    harness: HarnessId;
    model_label: string;
    model_id: string;
    agent_file: string | null;
  }>(
    `SELECT id, name, harness, model_label, model_id, agent_file
     FROM agents WHERE id = $1 LIMIT 1`,
    [id],
  );
  return result.rows[0] ?? null;
}

export async function insertAgent(
  db: PGlite,
  input: {
    id: string;
    name: string;
    description: string | null;
    agent_file: string;
    emoji: string;
    harness: HarnessId;
    model_label: string;
    model_id: string;
  },
): Promise<void> {
  await db.query(
    `INSERT INTO agents (id, name, description, status, agent_file, emoji, harness, model_label, model_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [input.id, input.name, input.description, "idle", input.agent_file, input.emoji, input.harness, input.model_label, input.model_id],
  );
}

export async function updateAgent(
  db: PGlite,
  input: {
    id: string;
    name: string;
    description: string | null;
    agent_file: string;
    emoji: string;
    harness: HarnessId;
    model_label: string;
    model_id: string;
  },
): Promise<number> {
  const result = await db.query(
    `UPDATE agents
     SET name = $2, description = $3, agent_file = $4, emoji = $5,
         harness = $6, model_label = $7, model_id = $8
     WHERE id = $1`,
    [input.id, input.name, input.description, input.agent_file, input.emoji, input.harness, input.model_label, input.model_id],
  );
  return result.affectedRows ?? 0;
}

export async function deleteAgent(db: PGlite, id: string): Promise<number> {
  await db.query(`UPDATE tasks SET assigned_to = NULL WHERE assigned_to = $1`, [id]);
  const result = await db.query(`DELETE FROM agents WHERE id = $1`, [id]);
  return result.affectedRows ?? 0;
}

export async function generateNextAgentId(db: PGlite, name: string): Promise<string> {
  const base = normalizeAgentIdBase(name);
  const likePattern = `${base}-%`;
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM agents WHERE id = $1 OR id LIKE $2`,
    [base, likePattern],
  );

  if (existing.rows.length === 0) {
    return base;
  }

  let maxSuffix = -1;
  const suffixRegex = new RegExp(`^${escapeRegex(base)}-(\\d+)$`);

  for (const row of existing.rows) {
    if (row.id === base) {
      maxSuffix = Math.max(maxSuffix, 0);
      continue;
    }
    const match = row.id.match(suffixRegex);
    if (!match) continue;
    const parsed = Number.parseInt(match[1], 10);
    if (Number.isInteger(parsed)) {
      maxSuffix = Math.max(maxSuffix, parsed);
    }
  }

  return `${base}-${Math.max(1, maxSuffix + 1)}`;
}

export async function listPlanWorkerCandidates(
  db: PGlite,
  defaultAgentId: string,
): Promise<Array<{
  id: string;
  name: string;
  description: string | null;
  harness: HarnessId;
  model_label: string;
}>> {
  const result = await db.query<{
    id: string;
    name: string;
    description: string | null;
    harness: HarnessId;
    model_label: string;
  }>(
    `SELECT id, name, description, harness, model_label
     FROM agents WHERE id <> $1 ORDER BY name ASC`,
    [defaultAgentId],
  );
  return result.rows;
}

function normalizeAgentIdBase(name: string): string {
  const normalized = name
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^[_-]+|[_-]+$/g, "");
  return normalized || "agent";
}

function escapeRegex(input: string): string {
  return input.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
