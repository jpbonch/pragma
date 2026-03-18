import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { PROVIDERS } from './providers.js';

const app = new Hono();

// CORS on /refresh/* only — allow localhost origins
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

function encodeBase64Url(data: string): string {
  return Buffer.from(data).toString('base64url');
}

function decodeBase64Url(data: string): string {
  return Buffer.from(data, 'base64url').toString('utf-8');
}

function getProxyPublicUrl(): string {
  const url = process.env.PROXY_PUBLIC_URL;
  if (!url) throw new Error('PROXY_PUBLIC_URL is not set');
  return url.replace(/\/+$/, '');
}

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

  const state = encodeBase64Url(
    JSON.stringify({ connector_id: connectorId, port: parseInt(port), ts: Date.now() }),
  );

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

  let state: { connector_id: string; port: number; ts: number };
  try {
    state = JSON.parse(decodeBase64Url(stateParam));
  } catch {
    return c.html('<h1>Error</h1><p>Invalid state parameter</p>', 400);
  }

  const TEN_MINUTES = 10 * 60 * 1000;
  if (Date.now() - state.ts > TEN_MINUTES) {
    return c.html('<h1>Error</h1><p>State expired. Please try again.</p>', 400);
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

  const callbackBase = `http://127.0.0.1:${state.port}/connectors/proxy-callback`;

  try {
    const resp = await fetch(provider.tokenUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!resp.ok) {
      const errText = await resp.text();
      const params = new URLSearchParams({
        error: errText || 'Token exchange failed',
        connector_id: state.connector_id,
      });
      return c.redirect(`${callbackBase}?${params.toString()}`);
    }

    const tokens = (await resp.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
    };

    const params = new URLSearchParams({
      connector_id: state.connector_id,
    });
    if (tokens.access_token) params.set('access_token', tokens.access_token);
    if (tokens.refresh_token) params.set('refresh_token', tokens.refresh_token);
    if (tokens.expires_in != null) params.set('expires_in', String(tokens.expires_in));

    return c.redirect(`${callbackBase}?${params.toString()}`);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Token exchange failed';
    const params = new URLSearchParams({
      error: message,
      connector_id: state.connector_id,
    });
    return c.redirect(`${callbackBase}?${params.toString()}`);
  }
});

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
import { serve } from '@hono/node-server';
const port = parseInt(process.env.PORT || '8787');
serve({ fetch: app.fetch, port });
console.log(`OAuth proxy running on port ${port}`);
