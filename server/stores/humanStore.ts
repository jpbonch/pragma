import type { PGlite } from "@electric-sql/pglite";

export type HumanRow = {
  id: string;
  emoji: string;
  created_at: string;
};

export async function listHumans(db: PGlite): Promise<HumanRow[]> {
  const result = await db.query<HumanRow>(
    `SELECT id, emoji, created_at FROM humans ORDER BY created_at ASC`,
  );
  return result.rows;
}

export async function insertHuman(db: PGlite, id: string, emoji: string): Promise<void> {
  await db.query(`INSERT INTO humans (id, emoji) VALUES ($1, $2)`, [id, emoji]);
}

export async function updateHuman(db: PGlite, id: string, emoji: string): Promise<number> {
  const result = await db.query(`UPDATE humans SET emoji = $2 WHERE id = $1`, [id, emoji]);
  return result.affectedRows ?? 0;
}

export async function deleteHuman(db: PGlite, id: string): Promise<number> {
  const result = await db.query(`DELETE FROM humans WHERE id = $1`, [id]);
  return result.affectedRows ?? 0;
}
