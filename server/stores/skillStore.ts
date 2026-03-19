import type { PGlite } from "@electric-sql/pglite";

export type SkillRow = {
  id: string;
  name: string;
  description: string | null;
  content: string;
};

export async function listSkills(db: PGlite): Promise<SkillRow[]> {
  const result = await db.query<SkillRow>(
    `SELECT id, name, description, content FROM skills ORDER BY name ASC`,
  );
  return result.rows;
}

export async function insertSkill(
  db: PGlite,
  input: { id: string; name: string; description: string | null; content: string },
): Promise<void> {
  await db.query(
    `INSERT INTO skills (id, name, description, content) VALUES ($1, $2, $3, $4)`,
    [input.id, input.name, input.description, input.content],
  );
}

export async function updateSkill(
  db: PGlite,
  id: string,
  updates: { name?: string; description?: string; content?: string },
): Promise<void> {
  const existing = await db.query<{ id: string }>(
    `SELECT id FROM skills WHERE id = $1 LIMIT 1`,
    [id],
  );
  if (existing.rows.length === 0) {
    return;
  }

  const sets: string[] = [];
  const params: unknown[] = [id];
  let paramIndex = 2;

  if (updates.name !== undefined) {
    sets.push(`name = $${paramIndex++}`);
    params.push(updates.name);
  }
  if (updates.description !== undefined) {
    sets.push(`description = $${paramIndex++}`);
    params.push(updates.description);
  }
  if (updates.content !== undefined) {
    sets.push(`content = $${paramIndex++}`);
    params.push(updates.content);
  }

  if (sets.length > 0) {
    await db.query(`UPDATE skills SET ${sets.join(", ")} WHERE id = $1`, params);
  }
}

export async function deleteSkill(db: PGlite, id: string): Promise<number> {
  const result = await db.query(`DELETE FROM skills WHERE id = $1`, [id]);
  return result.affectedRows ?? 0;
}

export async function getAgentSkills(
  db: PGlite,
  agentId: string,
): Promise<Array<{ id: string; name: string; description: string | null }>> {
  const result = await db.query<{ id: string; name: string; description: string | null }>(
    `SELECT s.id, s.name, s.description
     FROM skills s
     JOIN agent_skills as_rel ON as_rel.skill_id = s.id
     WHERE as_rel.agent_id = $1
     ORDER BY s.name ASC`,
    [agentId],
  );
  return result.rows;
}

export async function assignAgentSkill(
  db: PGlite,
  agentId: string,
  skillId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO agent_skills (agent_id, skill_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [agentId, skillId],
  );
}

export async function unassignAgentSkill(
  db: PGlite,
  agentId: string,
  skillId: string,
): Promise<number> {
  const result = await db.query(
    `DELETE FROM agent_skills WHERE agent_id = $1 AND skill_id = $2`,
    [agentId, skillId],
  );
  return result.affectedRows ?? 0;
}

export async function getAgentSkillContent(
  db: PGlite,
  agentId: string,
  skillId: string,
): Promise<string | null> {
  const result = await db.query<{ content: string }>(
    `SELECT s.content
     FROM skills s
     JOIN agent_skills as_rel ON as_rel.skill_id = s.id
     WHERE as_rel.agent_id = $1 AND s.id = $2
     LIMIT 1`,
    [agentId, skillId],
  );
  return result.rows[0]?.content ?? null;
}

export async function skillExists(db: PGlite, id: string): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM skills WHERE id = $1 LIMIT 1`,
    [id],
  );
  return result.rows.length > 0;
}
