import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { serve } from '@hono/node-server';
import { PROVIDERS } from './providers.js';

const app = new Hono();

// --- Secrets ---

// HMAC key for signing OAuth state tokens. Auto-generated per process if not set.
const STATE_SECRET = process.env.STATE_SECRET || randomBytes(32).toString('hex');

// --- CORS ---

app.use(
  '/refresh/*',
  cors({
    origin: (origin) => {
      if (!origin) return '';
      try {
        const url = new URL(origin);
        if (url.hostname === '127.0.0.1' || url.hostname === 'localhost') {
          return origin;
        }
      } catch {
        // invalid origin
      }
      return '';
    },
  }),
);

// --- Helpers ---

function signState(payload: object): string {
  const data = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', STATE_SECRET).update(data).digest('base64url');
  return `${data}.${sig}`;
}

function verifyState<T>(token: string): T | null {
  const dotIndex = token.indexOf('.');
  if (dotIndex === -1) return null;
  const data = token.slice(0, dotIndex);
  const sig = token.slice(dotIndex + 1);
  const expected = createHmac('sha256', STATE_SECRET).update(data).digest('base64url');
  const sigBuf = Buffer.from(sig);
  const expectedBuf = Buffer.from(expected);
  if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) return null;
  try {
    return JSON.parse(Buffer.from(data, 'base64url').toString('utf-8')) as T;
  } catch {
    return null;
  }
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#x27;');
}

function isValidPort(value: string): boolean {
  const num = Number(value);
  return Number.isInteger(num) && num >= 1024 && num <= 65535;
}

function getProxyPublicUrl(): string {
  const url = process.env.PROXY_PUBLIC_URL;
  if (!url) throw new Error('PROXY_PUBLIC_URL is not set');
  return url.replace(/\/+$/, '');
}

// --- Routes ---

// GET /auth/:provider
app.get('/auth/:provider', (c) => {
  const providerName = c.req.param('provider');
  const provider = PROVIDERS[providerName];
  if (!provider) {
    return c.json({ error: `Unknown provider: ${providerName}` }, 404);
  }

  const clientId = process.env[provider.clientIdEnvKey];
  if (!clientId) {
    return c.json({ error: `Missing env var ${provider.clientIdEnvKey}` }, 500);
  }

  const connectorId = c.req.query('connector_id') || '';
  const port = c.req.query('port') || '3000';

  if (!isValidPort(port)) {
    return c.json({ error: 'Invalid port: must be an integer between 1024 and 65535' }, 400);
  }

  const state = signState({
    connector_id: connectorId,
    port: parseInt(port),
    ts: Date.now(),
  });

  let proxyPublicUrl: string;
  try {
    proxyPublicUrl = getProxyPublicUrl();
  } catch {
    return c.json({ error: 'PROXY_PUBLIC_URL is not configured' }, 500);
  }

  const redirectUri = `${proxyPublicUrl}/callback/${providerName}`;

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: provider.scopes,
    state,
    response_type: 'code',
    access_type: 'offline',
    prompt: 'consent',
  });

  return c.redirect(`${provider.authUrl}?${params.toString()}`);
});

// GET /callback/:provider
app.get('/callback/:provider', async (c) => {
  const providerName = c.req.param('provider');
  const provider = PROVIDERS[providerName];
  if (!provider) {
    return c.html('<h1>Error</h1><p>Unknown provider</p>', 400);
  }

  const code = c.req.query('code');
  const stateParam = c.req.query('state');

  if (!code || !stateParam) {
    return c.html('<h1>Error</h1><p>Missing code or state parameter</p>', 400);
  }

  const state = verifyState<{ connector_id: string; port: number; ts: number }>(stateParam);
  if (!state) {
    return c.html('<h1>Error</h1><p>Invalid or tampered state parameter</p>', 400);
  }

  const TEN_MINUTES = 10 * 60 * 1000;
  if (Date.now() - state.ts > TEN_MINUTES) {
    return c.html('<h1>Error</h1><p>State expired. Please try again.</p>', 400);
  }

  if (!Number.isInteger(state.port) || state.port < 1024 || state.port > 65535) {
    return c.html('<h1>Error</h1><p>Invalid port in state</p>', 400);
  }

  const clientId = process.env[provider.clientIdEnvKey];
  const clientSecret = process.env[provider.clientSecretEnvKey];
  if (!clientId || !clientSecret) {
    return c.html('<h1>Error</h1><p>Server misconfigured: missing credentials</p>', 500);
  }

  let proxyPublicUrl: string;
  try {
    proxyPublicUrl = getProxyPublicUrl();
  } catch {
    return c.html('<h1>Error</h1><p>Server misconfigured: missing PROXY_PUBLIC_URL</p>', 500);
  }

  const redirectUri = `${proxyPublicUrl}/callback/${providerName}`;

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
  });

  const callbackUrl = `http://127.0.0.1:${state.port}/connectors/proxy-callback`;

  try {
    const resp = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return c.html(
        buildAutoPostForm(callbackUrl, {
          error: errText || 'Token exchange failed',
          connector_id: state.connector_id,
        }),
        200,
      );
    }

    const tokens = (await resp.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const fields: Record<string, string> = {
      connector_id: state.connector_id,
    };
    if (tokens.access_token) fields.access_token = tokens.access_token;
    if (tokens.refresh_token) fields.refresh_token = tokens.refresh_token;
    if (tokens.expires_in != null) fields.expires_in = String(tokens.expires_in);

    return c.html(buildAutoPostForm(callbackUrl, fields), 200);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token exchange failed';
    return c.html(
      buildAutoPostForm(callbackUrl, {
        error: message,
        connector_id: state.connector_id,
      }),
      200,
    );
  }
});

/**
 * Build an HTML page that auto-submits a POST form to the given URL.
 * Tokens are sent as POST body fields, never in the URL.
 */
function buildAutoPostForm(action: string, fields: Record<string, string>): string {
  const hiddenInputs = Object.entries(fields)
    .map(([k, v]) => `<input type="hidden" name="${escapeHtml(k)}" value="${escapeHtml(v)}" />`)
    .join('\n      ');

  return `<!DOCTYPE html>
<html>
<head><title>Redirecting…</title></head>
<body>
  <p>Completing authorization…</p>
  <form id="f" method="POST" action="${escapeHtml(action)}">
      ${hiddenInputs}
  </form>
  <script>document.getElementById('f').submit();</script>
</body>
</html>`;
}

// POST /refresh/:provider
app.post('/refresh/:provider', async (c) => {
  const providerName = c.req.param('provider');
  const provider = PROVIDERS[providerName];
  if (!provider) {
    return c.json({ error: `Unknown provider: ${providerName}` }, 404);
  }

  const clientId = process.env[provider.clientIdEnvKey];
  const clientSecret = process.env[provider.clientSecretEnvKey];
  if (!clientId || !clientSecret) {
    return c.json({ error: 'Server misconfigured: missing credentials' }, 500);
  }

  let refreshToken: string;
  try {
    const json = (await c.req.json()) as { refresh_token?: string };
    refreshToken = json.refresh_token || '';
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  if (!refreshToken) {
    return c.json({ error: 'Missing refresh_token' }, 400);
  }

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: clientId,
    client_secret: clientSecret,
  });

  try {
    const resp = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      return c.json({ error: errText || 'Token refresh failed' }, 502);
    }

    const tokens = (await resp.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    return c.json({
      access_token: tokens.access_token,
      ...(tokens.refresh_token && { refresh_token: tokens.refresh_token }),
      expires_in: tokens.expires_in,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token refresh failed';
    return c.json({ error: message }, 502);
  }
});

// Start server
const port = parseInt(process.env.PORT || '8787');
serve({ fetch: app.fetch, port });
console.log(`OAuth proxy running on port ${port}`);
