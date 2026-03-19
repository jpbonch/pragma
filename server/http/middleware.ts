import type { Context, Next } from "hono";
import { getActiveWorkspaceName, openDatabase, PragmaError } from "../db";

export type WorkspaceEnv = {
  Variables: {
    db: Awaited<ReturnType<typeof openDatabase>>;
    workspace: string;
  };
};

export type WorkspaceContext = Context<WorkspaceEnv>;

export async function workspaceMiddleware(c: Context<WorkspaceEnv>, next: Next): Promise<void> {
  const activeWorkspace = await getActiveWorkspaceName();
  if (!activeWorkspace) {
    throw new PragmaError(
      "NO_ACTIVE_WORKSPACE",
      409,
      "No active workspace. Create one or set an active workspace.",
    );
  }

  const db = await openDatabase(activeWorkspace);
  c.set("db", db);
  c.set("workspace", activeWorkspace);
  try {
    await next();
  } finally {
    await db.close();
  }
}
