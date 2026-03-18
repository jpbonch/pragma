import type { ConversationAdapter } from "./types";

export interface AdapterDefinition {
  /** Unique harness identifier, e.g. "codex", "claude_code" */
  id: string;

  /** CLI binary name to probe for availability, e.g. "codex", "claude" */
  command: string;

  /** Model label → model ID mapping, e.g. { "Opus 4.6": "opus" } */
  models: Record<string, string>;

  /** Optional: model ID override for cheap title generation */
  titleModelId?: string;

  /**
   * Directories (relative to $HOME) where this harness stores global skills.
   * Each entry is a { dir, label } pair, e.g. { dir: ".claude/skills", label: "Claude Code" }.
   */
  globalSkillsDirs?: { dir: string; label: string }[];

  /**
   * JSON config files (relative to $HOME) that may contain MCP server definitions.
   * Each entry specifies the file path and the JSON key that holds the server map.
   * E.g. { path: ".claude.json", key: "mcpServers" } for Claude Code.
   */
  mcpConfigFiles?: { path: string; key: string }[];

  /** Build the ConversationAdapter that handles sendTurn for this harness */
  createAdapter(): ConversationAdapter;
}

const registry = new Map<string, AdapterDefinition>();

export function registerAdapter(def: AdapterDefinition): void {
  registry.set(def.id, def);
}

export function getAdapterDefinition(id: string): AdapterDefinition {
  const def = registry.get(id);
  if (!def) {
    throw new Error(`Unknown adapter: ${id}`);
  }
  return def;
}

export function allAdapterDefinitions(): AdapterDefinition[] {
  return [...registry.values()];
}

export function getRegisteredHarnessIds(): string[] {
  return [...registry.keys()].sort();
}
