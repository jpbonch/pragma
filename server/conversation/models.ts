import { PragmaError } from "../db";
import { getAdapterDefinition, allAdapterDefinitions } from "./adapterRegistry";

export function resolveModelId(harness: string, label: string): string {
  const def = getAdapterDefinition(harness);
  const modelId = def.models[label];
  if (!modelId) {
    throw new PragmaError(
      "INVALID_MODEL",
      400,
      `Unknown model for harness ${harness}: ${label}`,
    );
  }
  return modelId;
}

export function modelOptionsByHarness(): Record<string, string[]> {
  const result: Record<string, string[]> = {};
  for (const def of allAdapterDefinitions()) {
    result[def.id] = Object.keys(def.models);
  }
  return result;
}
