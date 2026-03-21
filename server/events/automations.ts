import { randomBytes } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { EventBus, PragmaEvent } from "./event-bus";

export interface Automation {
  id: string;
  name: string;
  trigger: { eventType: string; filter?: Record<string, any> };
  action: AutomationAction;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

export type AutomationAction =
  | { type: "webhook"; url: string; headers?: Record<string, string>; method?: string }
  | { type: "create_task"; title: string; assignedTo?: string }
  | { type: "log"; message?: string };

function matchesFilter(
  filter: Record<string, any> | undefined,
  payload: Record<string, any>,
): boolean {
  if (!filter) return true;
  for (const key of Object.keys(filter)) {
    if (payload[key] !== filter[key]) return false;
  }
  return true;
}

function applyTemplateVars(template: string, event: PragmaEvent): string {
  return template
    .replace(/\{\{event\.type\}\}/g, event.type)
    .replace(/\{\{event\.taskId\}\}/g, event.taskId ?? "")
    .replace(/\{\{event\.threadId\}\}/g, event.threadId ?? "")
    .replace(/\{\{event\.source\}\}/g, event.source);
}

async function executeAction(
  automation: Automation,
  event: PragmaEvent,
  db: PGlite,
): Promise<{ status: string; result: Record<string, any> }> {
  const action = automation.action;

  switch (action.type) {
    case "webhook": {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      try {
        const method = action.method ?? "POST";
        const response = await fetch(action.url, {
          method,
          headers: {
            "content-type": "application/json",
            ...action.headers,
          },
          body: JSON.stringify(event.payload),
          signal: controller.signal,
        });
        return {
          status: "success",
          result: { statusCode: response.status, statusText: response.statusText },
        };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { status: "error", result: { error: message } };
      } finally {
        clearTimeout(timeout);
      }
    }

    case "create_task": {
      const taskId = `task_${randomBytes(4).toString("hex")}`;
      const title = applyTemplateVars(action.title, event);
      await db.query(
        `INSERT INTO tasks (id, title, status, assigned_to) VALUES ($1, $2, 'queued', $3)`,
        [taskId, title, action.assignedTo ?? null],
      );
      return { status: "success", result: { taskId } };
    }

    case "log": {
      const msg = action.message
        ? applyTemplateVars(action.message, event)
        : JSON.stringify(event.payload);
      console.log(`[automation] ${automation.name}: ${msg}`);
      return { status: "success", result: { logged: true } };
    }

    default:
      return { status: "error", result: { error: "Unknown action type" } };
  }
}

async function recordRun(
  db: PGlite,
  automationId: string,
  eventId: string,
  status: string,
  result: Record<string, any>,
): Promise<void> {
  const runId = `arun_${randomBytes(12).toString("hex")}`;
  await db.query(
    `INSERT INTO automation_runs (id, automation_id, event_id, status, result_json)
     VALUES ($1, $2, $3, $4, $5)`,
    [runId, automationId, eventId, status, JSON.stringify(result)],
  );
}

export class AutomationRegistry {
  private eventBus: EventBus;
  private subscriptions = new Map<string, () => void>();
  private automations = new Map<string, Automation>();
  private db: PGlite | null = null;

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  setDatabase(db: PGlite): void {
    this.db = db;
  }

  async loadFromDatabase(db: PGlite): Promise<void> {
    this.db = db;
    const result = await db.query<{
      id: string;
      name: string;
      trigger_event_type: string;
      trigger_filter_json: string | null;
      action_type: string;
      action_config_json: string;
      enabled: boolean;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, name, trigger_event_type, trigger_filter_json,
              action_type, action_config_json, enabled, created_at, updated_at
       FROM workspace_automations WHERE enabled = true`,
    );

    for (const row of result.rows) {
      const automation = rowToAutomation(row);
      this.register(automation);
    }
  }

  register(automation: Automation): void {
    // Unregister first if already registered
    if (this.subscriptions.has(automation.id)) {
      this.unregister(automation.id);
    }

    this.automations.set(automation.id, automation);

    if (!automation.enabled) return;

    const unsubscribe = this.eventBus.on(automation.trigger.eventType, (event) => {
      if (!matchesFilter(automation.trigger.filter, event.payload)) return;
      if (!this.db) return;
      const db = this.db;
      void (async () => {
        try {
          const { status, result } = await executeAction(automation, event, db);
          await recordRun(db, automation.id, event.id, status, result);
        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          try {
            await recordRun(db, automation.id, event.id, "error", { error: message });
          } catch {
            // recording failure silenced
          }
        }
      })();
    });

    this.subscriptions.set(automation.id, unsubscribe);
  }

  unregister(automationId: string): void {
    const unsubscribe = this.subscriptions.get(automationId);
    if (unsubscribe) {
      unsubscribe();
      this.subscriptions.delete(automationId);
    }
    this.automations.delete(automationId);
  }

  async reload(db: PGlite): Promise<void> {
    // Unregister all existing
    for (const id of [...this.subscriptions.keys()]) {
      this.unregister(id);
    }
    await this.loadFromDatabase(db);
  }
}

export function rowToAutomation(row: {
  id: string;
  name: string;
  trigger_event_type: string;
  trigger_filter_json: string | null;
  action_type: string;
  action_config_json: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}): Automation {
  const config = JSON.parse(row.action_config_json);
  let action: AutomationAction;

  switch (row.action_type) {
    case "webhook":
      action = { type: "webhook", url: config.url, headers: config.headers, method: config.method };
      break;
    case "create_task":
      action = { type: "create_task", title: config.title, assignedTo: config.assignedTo };
      break;
    case "log":
      action = { type: "log", message: config.message };
      break;
    default:
      action = { type: "log", message: `Unknown action type: ${row.action_type}` };
  }

  return {
    id: row.id,
    name: row.name,
    trigger: {
      eventType: row.trigger_event_type,
      filter: row.trigger_filter_json ? JSON.parse(row.trigger_filter_json) : undefined,
    },
    action,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function automationToRow(automation: Automation): {
  action_type: string;
  action_config_json: string;
} {
  const { type, ...config } = automation.action;
  return {
    action_type: type,
    action_config_json: JSON.stringify(config),
  };
}
