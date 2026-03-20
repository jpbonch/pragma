export interface OAuthProvider {
  authUrl: string;
  tokenUrl: string;
  scopes: string;
  clientIdEnvKey: string;
  clientSecretEnvKey: string;
  /** When true, send client credentials via HTTP Basic Auth header instead of form body */
  useBasicAuth?: boolean;
  /** Notion-specific: include owner=user param in auth URL */
  authExtraParams?: Record<string, string>;
}

export const PROVIDERS: Record<string, OAuthProvider> = {
  google: {
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    scopes:
      'https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets',
    clientIdEnvKey: 'GOOGLE_CLIENT_ID',
    clientSecretEnvKey: 'GOOGLE_CLIENT_SECRET',
  },
  slack: {
    authUrl: 'https://slack.com/oauth/v2/authorize',
    tokenUrl: 'https://slack.com/api/oauth.v2.access',
    scopes: 'chat:write channels:read channels:history groups:read im:read',
    clientIdEnvKey: 'SLACK_CLIENT_ID',
    clientSecretEnvKey: 'SLACK_CLIENT_SECRET',
  },
  notion: {
    authUrl: 'https://api.notion.com/v1/oauth/authorize',
    tokenUrl: 'https://api.notion.com/v1/oauth/token',
    scopes: '',
    clientIdEnvKey: 'NOTION_CLIENT_ID',
    clientSecretEnvKey: 'NOTION_CLIENT_SECRET',
    useBasicAuth: true,
    authExtraParams: { owner: 'user' },
  },
};
