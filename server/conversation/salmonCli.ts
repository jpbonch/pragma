import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

export function resolveSalmonCliCommand(runtimeDir: string): string {
  const fromEnv = normalizeCliCommand(process.env.SALMON_CLI_COMMAND);
  if (fromEnv) {
    return fromEnv;
  }

  const candidates = [
    join(runtimeDir, "..", "cli", "index.js"),
    join(runtimeDir, "..", "..", "dist", "cli", "index.js"),
    join(process.cwd(), "dist", "cli", "index.js"),
  ].map((candidate) => resolve(candidate));

  const existing = candidates.find((candidate) => existsSync(candidate));
  if (existing) {
    return `node ${quoteShellArg(existing)}`;
  }

  return "salmon";
}

function normalizeCliCommand(value: string | undefined): string | null {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function quoteShellArg(value: string): string {
  return `"${value.replace(/["\\$`]/g, "\\$&")}"`;
}

