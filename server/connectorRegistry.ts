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
  /** When true, send client credentials via HTTP Basic Auth header instead of form body (e.g. Notion) */
  useBasicAuth?: boolean;
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
    content: `# notion

Use the Notion API to create/read/update pages, data sources (databases), and blocks.

## API Basics

All requests need:
\`\`\`bash
curl -X GET "https://api.notion.com/v1/..." \\
  -H "Authorization: Bearer $NOTION_TOKEN" \\
  -H "Notion-Version: 2025-09-03" \\
  -H "Content-Type: application/json"
\`\`\`

> **Note:** The \`Notion-Version\` header is required. This skill uses \`2025-09-03\` (latest). In this version, databases are called "data sources" in the API.

## Common Operations

**Search for pages and data sources:**
\`\`\`bash
curl -X POST "https://api.notion.com/v1/search" \\
  -H "Authorization: Bearer $NOTION_TOKEN" \\
  -H "Notion-Version: 2025-09-03" \\
  -H "Content-Type: application/json" \\
  -d '{"query": "page title"}'
\`\`\`

**Get page:**
\`\`\`bash
curl "https://api.notion.com/v1/pages/{page_id}" \\
  -H "Authorization: Bearer $NOTION_TOKEN" \\
  -H "Notion-Version: 2025-09-03"
\`\`\`

**Get page content (blocks):**
\`\`\`bash
curl "https://api.notion.com/v1/blocks/{page_id}/children" \\
  -H "Authorization: Bearer $NOTION_TOKEN" \\
  -H "Notion-Version: 2025-09-03"
\`\`\`

**Create page in a data source:**
\`\`\`bash
curl -X POST "https://api.notion.com/v1/pages" \\
  -H "Authorization: Bearer $NOTION_TOKEN" \\
  -H "Notion-Version: 2025-09-03" \\
  -H "Content-Type: application/json" \\
  -d '{
    "parent": {"database_id": "xxx"},
    "properties": {
      "Name": {"title": [{"text": {"content": "New Item"}}]},
      "Status": {"select": {"name": "Todo"}}
    }
  }'
\`\`\`

**Query a data source (database):**
\`\`\`bash
curl -X POST "https://api.notion.com/v1/data_sources/{data_source_id}/query" \\
  -H "Authorization: Bearer $NOTION_TOKEN" \\
  -H "Notion-Version: 2025-09-03" \\
  -H "Content-Type: application/json" \\
  -d '{
    "filter": {"property": "Status", "select": {"equals": "Active"}},
    "sorts": [{"property": "Date", "direction": "descending"}]
  }'
\`\`\`

**Create a data source (database):**
\`\`\`bash
curl -X POST "https://api.notion.com/v1/data_sources" \\
  -H "Authorization: Bearer $NOTION_TOKEN" \\
  -H "Notion-Version: 2025-09-03" \\
  -H "Content-Type: application/json" \\
  -d '{
    "parent": {"page_id": "xxx"},
    "title": [{"text": {"content": "My Database"}}],
    "properties": {
      "Name": {"title": {}},
      "Status": {"select": {"options": [{"name": "Todo"}, {"name": "Done"}]}},
      "Date": {"date": {}}
    }
  }'
\`\`\`

**Update page properties:**
\`\`\`bash
curl -X PATCH "https://api.notion.com/v1/pages/{page_id}" \\
  -H "Authorization: Bearer $NOTION_TOKEN" \\
  -H "Notion-Version: 2025-09-03" \\
  -H "Content-Type: application/json" \\
  -d '{"properties": {"Status": {"select": {"name": "Done"}}}}'
\`\`\`

**Add blocks to page:**
\`\`\`bash
curl -X PATCH "https://api.notion.com/v1/blocks/{page_id}/children" \\
  -H "Authorization: Bearer $NOTION_TOKEN" \\
  -H "Notion-Version: 2025-09-03" \\
  -H "Content-Type: application/json" \\
  -d '{
    "children": [
      {"object": "block", "type": "paragraph", "paragraph": {"rich_text": [{"text": {"content": "Hello"}}]}}
    ]
  }'
\`\`\`

## Property Types

Common property formats for database items:
- **Title:** \`{"title": [{"text": {"content": "..."}}]}\`
- **Rich text:** \`{"rich_text": [{"text": {"content": "..."}}]}\`
- **Select:** \`{"select": {"name": "Option"}}\`
- **Multi-select:** \`{"multi_select": [{"name": "A"}, {"name": "B"}]}\`
- **Date:** \`{"date": {"start": "2024-01-15", "end": "2024-01-16"}}\`
- **Checkbox:** \`{"checkbox": true}\`
- **Number:** \`{"number": 42}\`
- **URL:** \`{"url": "https://..."}\`
- **Email:** \`{"email": "a@b.com"}\`
- **Relation:** \`{"relation": [{"id": "page_id"}]}\`

## Key Differences in 2025-09-03

- **Databases -> Data Sources:** Use \`/data_sources/\` endpoints for queries and retrieval
- **Two IDs:** Each database now has both a \`database_id\` and a \`data_source_id\`
  - Use \`database_id\` when creating pages (\`parent: {"database_id": "..."}\`)
  - Use \`data_source_id\` when querying (\`POST /v1/data_sources/{id}/query\`)
- **Search results:** Databases return as \`"object": "data_source"\` with their \`data_source_id\`
- **Parent in responses:** Pages show \`parent.data_source_id\` alongside \`parent.database_id\`
- **Finding the data_source_id:** Search for the database, or call \`GET /v1/data_sources/{data_source_id}\`

## Notes

- Page/database IDs are UUIDs (with or without dashes)
- The API cannot set database view filters — that's UI-only
- Rate limit: ~3 requests/second average
- Use \`is_inline: true\` when creating data sources to embed them in pages
`,
    provider: "notion",
    binaryName: "notion",
    envVar: "NOTION_TOKEN",
    authType: "oauth2",
    oauthAuthUrl: "https://api.notion.com/v1/oauth/authorize",
    oauthTokenUrl: "https://api.notion.com/v1/oauth/token",
    scopes: "",
    proxyProvider: "notion",
    useBasicAuth: true,
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
