export interface ConnectorDef {
  name: string;
  displayName: string;
  description: string;
  content: string;
  provider: string;
  binaryName: string;
  envVar: string;
  authType: "oauth2";
  oauthAuthUrl: string;
  oauthTokenUrl: string;
  scopes: string;
  proxyProvider?: string;
  getBinaryUrl(platform: string, arch: string): string;
}

export const OAUTH_PROXY_URL = process.env.PRAGMA_OAUTH_PROXY_URL || 'https://pragma-production-f107.up.railway.app';

export const CONNECTOR_REGISTRY: ConnectorDef[] = [
  {
    name: "google-workspace",
    displayName: "Google Workspace",
    description: "Google Calendar, Gmail, Drive, Sheets, Docs via gws CLI",
    content: `# Google Workspace

You have access to Google Workspace services via the \`gws\` CLI.
Authentication is pre-configured — just run commands directly.

## Calendar
\`\`\`
gws calendar events list --calendar-id primary --max-results 10
gws calendar events insert --calendar-id primary --summary "Meeting" --start-date-time "2024-03-20T10:00:00Z" --end-date-time "2024-03-20T11:00:00Z"
\`\`\`

## Gmail
\`\`\`
gws gmail messages list --user-id me --max-results 10 --query "is:unread"
gws gmail messages get --user-id me --id <messageId>
gws gmail messages send --user-id me --to "user@example.com" --subject "Subject" --body "Body"
\`\`\`

## Drive
\`\`\`
gws drive files list --page-size 10
gws drive files get --file-id <fileId>
\`\`\`

## Sheets
\`\`\`
gws sheets spreadsheets-values get --spreadsheet-id <id> --range "Sheet1!A1:D10"
\`\`\`

Run \`gws <service> --help\` to discover all available commands.
`,
    provider: "google",
    binaryName: "gws",
    envVar: "GOOGLE_WORKSPACE_CLI_TOKEN",
    authType: "oauth2",
    oauthAuthUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    oauthTokenUrl: "https://oauth2.googleapis.com/token",
    scopes:
      "https://www.googleapis.com/auth/calendar https://www.googleapis.com/auth/gmail.modify https://www.googleapis.com/auth/drive https://www.googleapis.com/auth/spreadsheets",
    proxyProvider: "google",
    getBinaryUrl: (platform: string, arch: string) => {
      const targets: Record<string, string> = {
        "darwin-arm64": "aarch64-apple-darwin",
        "darwin-x64": "x86_64-apple-darwin",
        "linux-arm64": "aarch64-unknown-linux-gnu",
        "linux-x64": "x86_64-unknown-linux-gnu",
      };
      const target =
        targets[`${platform}-${arch}`] ?? "x86_64-unknown-linux-gnu";
      return `https://github.com/googleworkspace/cli/releases/download/v0.17.0/gws-${target}.tar.gz`;
    },
  },
  {
    name: "slack",
    displayName: "Slack",
    description: "Send messages, read channels, manage Slack workspace",
    content: `# Slack

You have access to Slack via the \`agent-slack\` CLI.
Authentication is pre-configured.

## Send a message
\`\`\`
agent-slack send --channel "#general" --text "Hello from Pragma"
\`\`\`

## Read messages
\`\`\`
agent-slack read --channel "#general" --limit 20
\`\`\`

## List channels
\`\`\`
agent-slack channels
\`\`\`

Run \`agent-slack --help\` to see all commands.
`,
    provider: "slack",
    binaryName: "agent-slack",
    envVar: "SLACK_TOKEN",
    authType: "oauth2",
    oauthAuthUrl: "https://slack.com/oauth/v2/authorize",
    oauthTokenUrl: "https://slack.com/api/oauth.v2.access",
    scopes: "chat:write channels:read channels:history groups:read im:read",
    proxyProvider: "slack",
    getBinaryUrl: () => "npm:agent-slack",
  },
  {
    name: "notion",
    displayName: "Notion",
    description: "Search, read, and create Notion pages and databases",
    content: `# Notion

You have access to Notion via the \`notion\` CLI.
Authentication is pre-configured.

## Search
\`\`\`
notion search --query "project plan"
\`\`\`

## Pages
\`\`\`
notion page get <page-id>
notion page create --parent <parent-id> --title "New Page" --content "Page content"
\`\`\`

## Databases
\`\`\`
notion db list
notion db query <database-id> --filter '{"property":"Status","select":{"equals":"In Progress"}}'
\`\`\`

Run \`notion --help\` to see all commands.
`,
    provider: "notion",
    binaryName: "notion",
    envVar: "NOTION_TOKEN",
    authType: "oauth2",
    oauthAuthUrl: "https://api.notion.com/v1/oauth/authorize",
    oauthTokenUrl: "https://api.notion.com/v1/oauth/token",
    scopes: "",
    getBinaryUrl: (platform: string, arch: string) => {
      const targets: Record<string, string> = {
        "darwin-arm64": "darwin_arm64",
        "darwin-x64": "darwin_amd64",
        "linux-arm64": "linux_arm64",
        "linux-x64": "linux_amd64",
      };
      const target = targets[`${platform}-${arch}`] ?? "linux_amd64";
      return `https://github.com/4ier/notion-cli/releases/download/v0.3.0/notion-cli_0.3.0_${target}.tar.gz`;
    },
  },
];
