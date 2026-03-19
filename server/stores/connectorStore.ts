import type { PGlite } from "@electric-sql/pglite";

export type ConnectorListRow = {
  id: string;
  name: string;
  display_name: string | null;
  description: string | null;
  provider: string;
  status: string;
  auth_type: string;
  oauth_client_id: string | null;
  oauth_client_secret: string | null;
};

export type ConnectorAuthRow = {
  id: string;
  name: string;
  oauth_client_id: string | null;
  oauth_client_secret: string | null;
  oauth_auth_url: string;
  scopes: string;
  redirect_uri: string;
  auth_type: string;
};

export type ConnectorTokenRow = {
  id: string;
  oauth_client_id: string;
  oauth_client_secret: string;
  oauth_token_url: string;
  redirect_uri: string;
};

export async function listConnectors(db: PGlite): Promise<ConnectorListRow[]> {
  const result = await db.query<ConnectorListRow>(
    `SELECT id, name, display_name, description, provider, status, auth_type,
            oauth_client_id, oauth_client_secret
     FROM connectors ORDER BY name ASC`,
  );
  return result.rows;
}

export async function getConnectorAuthInfo(
  db: PGlite,
  connectorId: string,
): Promise<ConnectorAuthRow | null> {
  const result = await db.query<ConnectorAuthRow>(
    `SELECT id, name, oauth_client_id, oauth_client_secret, oauth_auth_url,
            scopes, redirect_uri, auth_type
     FROM connectors WHERE id = $1 LIMIT 1`,
    [connectorId],
  );
  return result.rows[0] ?? null;
}

export async function getConnectorForConfig(
  db: PGlite,
  connectorId: string,
): Promise<{ id: string; name: string; auth_type: string } | null> {
  const result = await db.query<{ id: string; name: string; auth_type: string }>(
    `SELECT id, name, auth_type FROM connectors WHERE id = $1 LIMIT 1`,
    [connectorId],
  );
  return result.rows[0] ?? null;
}

export async function setConnectorApiKeyToken(
  db: PGlite,
  connectorId: string,
  accessToken: string,
): Promise<void> {
  await db.query(
    `UPDATE connectors SET access_token = $1, status = 'connected' WHERE id = $2`,
    [accessToken, connectorId],
  );
}

export async function updateConnectorOAuthConfig(
  db: PGlite,
  connectorId: string,
  updates: { oauth_client_id?: string | null; oauth_client_secret?: string | null },
): Promise<void> {
  const sets: string[] = [];
  const params: unknown[] = [connectorId];
  let paramIndex = 2;

  if (updates.oauth_client_id !== undefined) {
    sets.push(`oauth_client_id = $${paramIndex++}`);
    params.push(updates.oauth_client_id || null);
  }
  if (updates.oauth_client_secret !== undefined) {
    sets.push(`oauth_client_secret = $${paramIndex++}`);
    params.push(updates.oauth_client_secret || null);
  }

  if (sets.length > 0) {
    sets.push(`status = 'disconnected'`);
    await db.query(`UPDATE connectors SET ${sets.join(", ")} WHERE id = $1`, params);
  }
}

export async function connectorExists(db: PGlite, connectorId: string): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM connectors WHERE id = $1 LIMIT 1`,
    [connectorId],
  );
  return result.rows.length > 0;
}

export async function storeConnectorTokens(
  db: PGlite,
  connectorId: string,
  accessToken: string,
  refreshToken: string | null,
  tokenExpiresAt: string,
): Promise<void> {
  await db.query(
    `UPDATE connectors
     SET access_token = $1, refresh_token = $2, token_expires_at = $3, status = 'connected'
     WHERE id = $4`,
    [accessToken, refreshToken, tokenExpiresAt, connectorId],
  );
}

export async function disconnectConnector(db: PGlite, connectorId: string): Promise<void> {
  await db.query(
    `UPDATE connectors
     SET status = 'disconnected', access_token = NULL,
         refresh_token = NULL, token_expires_at = NULL
     WHERE id = $1`,
    [connectorId],
  );
}

export async function refreshConnectorToken(
  db: PGlite,
  connector: {
    id: string;
    name: string;
    access_token: string | null;
    refresh_token: string | null;
    token_expires_at: string | null;
    oauth_token_url: string;
    oauth_client_id: string | null;
    oauth_client_secret: string | null;
    auth_type: string;
  },
  proxyUrl: string,
  proxyProvider: string | undefined,
  hasCustomCredentials: boolean,
): Promise<string> {
  if (connector.auth_type === "api_key") {
    return connector.access_token!;
  }

  if (connector.token_expires_at && new Date(connector.token_expires_at) > new Date()) {
    return connector.access_token!;
  }

  if (!connector.refresh_token) {
    throw new Error("No refresh token available — connector needs re-authorization");
  }

  let response: Response;

  if (proxyProvider && !hasCustomCredentials) {
    response = await fetch(`${proxyUrl}/refresh/${proxyProvider}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: connector.refresh_token }),
    });
  } else {
    response = await fetch(connector.oauth_token_url, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: connector.refresh_token,
        client_id: connector.oauth_client_id!,
        client_secret: connector.oauth_client_secret!,
      }),
    });
  }

  if (!response.ok) {
    await db.query(
      `UPDATE connectors SET status = 'disconnected', access_token = NULL,
       refresh_token = NULL, token_expires_at = NULL WHERE id = $1`,
      [connector.id],
    );
    throw new Error("Token refresh failed — connector disconnected");
  }

  const data = (await response.json()) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };

  await db.query(
    `UPDATE connectors SET access_token = $1, refresh_token = COALESCE($2, refresh_token),
     token_expires_at = $3 WHERE id = $4`,
    [
      data.access_token,
      data.refresh_token ?? null,
      new Date(Date.now() + (data.expires_in ?? 3600) * 1000).toISOString(),
      connector.id,
    ],
  );

  return data.access_token;
}

export async function getConnectorName(db: PGlite, connectorId: string): Promise<string | null> {
  const result = await db.query<{ name: string }>(
    `SELECT name FROM connectors WHERE id = $1 LIMIT 1`,
    [connectorId],
  );
  return result.rows[0]?.name ?? null;
}

export async function getAgentConnectors(
  db: PGlite,
  agentId: string,
): Promise<Array<{ id: string; name: string; description: string | null; status: string }>> {
  const result = await db.query<{
    id: string;
    name: string;
    description: string | null;
    status: string;
  }>(
    `SELECT c.id, c.name, c.description, c.status
     FROM connectors c
     JOIN agent_connectors ac ON ac.connector_id = c.id
     WHERE ac.agent_id = $1
     ORDER BY c.name ASC`,
    [agentId],
  );
  return result.rows;
}

export async function assignAgentConnector(
  db: PGlite,
  agentId: string,
  connectorId: string,
): Promise<void> {
  await db.query(
    `INSERT INTO agent_connectors (agent_id, connector_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
    [agentId, connectorId],
  );
}

export async function unassignAgentConnector(
  db: PGlite,
  agentId: string,
  connectorId: string,
): Promise<number> {
  const result = await db.query(
    `DELETE FROM agent_connectors WHERE agent_id = $1 AND connector_id = $2`,
    [agentId, connectorId],
  );
  return result.affectedRows ?? 0;
}

export async function getAgentConnectorContent(
  db: PGlite,
  agentId: string,
  connectorId: string,
): Promise<string | null> {
  const result = await db.query<{ content: string }>(
    `SELECT c.content
     FROM connectors c
     JOIN agent_connectors ac ON ac.connector_id = c.id
     WHERE ac.agent_id = $1 AND c.id = $2
     LIMIT 1`,
    [agentId, connectorId],
  );
  return result.rows[0]?.content ?? null;
}

export async function getConnectorTokenInfo(
  db: PGlite,
  connectorId: string,
): Promise<ConnectorTokenRow | null> {
  const result = await db.query<ConnectorTokenRow>(
    `SELECT id, oauth_client_id, oauth_client_secret, oauth_token_url, redirect_uri
     FROM connectors WHERE id = $1 LIMIT 1`,
    [connectorId],
  );
  return result.rows[0] ?? null;
}

export async function agentExists(db: PGlite, agentId: string): Promise<boolean> {
  const result = await db.query<{ id: string }>(
    `SELECT id FROM agents WHERE id = $1 LIMIT 1`,
    [agentId],
  );
  return result.rows.length > 0;
}
