import { randomBytes } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import type { EventBus, PragmaEvent } from "./event-bus";
import { createEvent } from "./event-bus";

export interface Automation {
  id: string;
  name: string;
  triggerType: "event" | "schedule";
  trigger: { eventType: string };
  schedule?: { cron: string; timezone: string };
  action: AutomationAction;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
  lastScheduledAt?: string;
}

export type AutomationAction =
  | { type: "webhook"; url: string; headers?: Record<string, string>; method?: string }
  | { type: "create_task"; title: string; assignedTo?: string }
  | { type: "execute_task"; prompt: string; recipientAgentId?: string; reasoningEffort?: "low" | "medium" | "high" | "extra_high" }
  | { type: "execute_background_task"; prompt: string; recipientAgentId?: string; reasoningEffort?: "low" | "medium" | "high" | "extra_high" }
  | { type: "log"; message?: string };

function matchesFilter(
  filter: Record<string, any> | undefined,
  payload: Record<string, any>,
): boolean {
  if (!filter) return true;
  for (const key of Object.keys(filter)) {
    const expected = filter[key];
    // Support { $ne: value } for not-equal checks
    if (expected && typeof expected === "object" && "$ne" in expected) {
      if (payload[key] === expected.$ne) return false;
    } else {
      if (payload[key] !== expected) return false;
    }
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
  apiUrl: string,
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

    case "execute_task":
    case "execute_background_task": {
      const prompt = applyTemplateVars(action.prompt, event);
      const body: Record<string, string | boolean> = { prompt };
      body.reasoning_effort = action.reasoningEffort ?? "high";
      if (action.recipientAgentId) {
        body.recipient_agent_id = action.recipientAgentId;
      }
      if (action.type === "execute_background_task") {
        body.background = true;
      }
      try {
        const response = await fetch(`${apiUrl}/tasks/execute`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => "");
          return { status: "error", result: { statusCode: response.status, error: text } };
        }
        const data = (await response.json()) as Record<string, unknown>;
        return { status: "success", result: { taskId: data.task_id } };
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        return { status: "error", result: { error: message } };
      }
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

// ---- Lightweight cron matching ----

function matchesCronField(field: string, value: number): boolean {
  if (field === "*") return true;

  for (const part of field.split(",")) {
    // Handle step values: */5 or 1-10/2
    if (part.includes("/")) {
      const [range, stepStr] = part.split("/");
      const step = parseInt(stepStr, 10);
      if (isNaN(step) || step <= 0) continue;
      if (range === "*") {
        if (value % step === 0) return true;
      } else if (range.includes("-")) {
        const [lo, hi] = range.split("-").map(Number);
        if (value >= lo && value <= hi && (value - lo) % step === 0) return true;
      }
      continue;
    }

    // Handle ranges: 1-5
    if (part.includes("-")) {
      const [lo, hi] = part.split("-").map(Number);
      if (value >= lo && value <= hi) return true;
      continue;
    }

    // Exact value
    if (parseInt(part, 10) === value) return true;
  }

  return false;
}

export function cronMatchesNow(cron: string, now: Date): boolean {
  const parts = cron.trim().split(/\s+/);
  if (parts.length < 5) return false;

  const [minute, hour, dayOfMonth, month, dayOfWeek] = parts;
  return (
    matchesCronField(minute, now.getMinutes()) &&
    matchesCronField(hour, now.getHours()) &&
    matchesCronField(dayOfMonth, now.getDate()) &&
    matchesCronField(month, now.getMonth() + 1) &&
    matchesCronField(dayOfWeek, now.getDay())
  );
}

export class AutomationRegistry {
  private eventBus: EventBus;
  private subscriptions = new Map<string, () => void>();
  private automations = new Map<string, Automation>();
  private db: PGlite | null = null;
  private scheduleTimer: ReturnType<typeof setInterval> | null = null;
  private apiUrl: string = "";

  constructor(eventBus: EventBus) {
    this.eventBus = eventBus;
  }

  setDatabase(db: PGlite): void {
    this.db = db;
  }

  setApiUrl(url: string): void {
    this.apiUrl = url;
  }

  async loadFromDatabase(db: PGlite): Promise<void> {
    this.db = db;
    const result = await db.query<{
      id: string;
      name: string;
      trigger_event_type: string;
      trigger_type: string;
      schedule_cron: string | null;
      schedule_timezone: string;
      last_scheduled_at: string | null;
      action_type: string;
      action_config_json: string;
      enabled: boolean;
      created_at: string;
      updated_at: string;
    }>(
      `SELECT id, name, trigger_event_type,
              trigger_type, schedule_cron, schedule_timezone, last_scheduled_at,
              action_type, action_config_json, enabled, created_at, updated_at
       FROM workspace_automations WHERE enabled = true`,
    );

    for (const row of result.rows) {
      const automation = rowToAutomation(row);
      this.register(automation);
    }

    this.startScheduleRunner();
  }

  register(automation: Automation): void {
    // Unregister first if already registered
    if (this.subscriptions.has(automation.id)) {
      this.unregister(automation.id);
    }

    this.automations.set(automation.id, automation);

    if (!automation.enabled) return;

    // Only register event listener for event-based automations
    if (automation.triggerType === "event") {
      const unsubscribe = this.eventBus.on(automation.trigger.eventType, (event) => {
        if (!this.db) return;
        // Built-in anti-loop: skip events from the same agent the automation targets
        if (automation.action.type === "execute_task" && automation.action.recipientAgentId) {
          if (event.payload?.assigned_to === automation.action.recipientAgentId) return;
        }
        if (automation.action.type === "create_task" && automation.action.assignedTo) {
          if (event.payload?.assigned_to === automation.action.assignedTo) return;
        }
        const db = this.db;
        const apiUrl = this.apiUrl;
        void (async () => {
          try {
            const { status, result } = await executeAction(automation, event, db, apiUrl);
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
    // Schedule-based automations are handled by the schedule runner
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
    // Also clear automations that don't have subscriptions (schedules)
    this.automations.clear();
    await this.loadFromDatabase(db);
  }

  stopScheduleRunner(): void {
    if (this.scheduleTimer) {
      clearInterval(this.scheduleTimer);
      this.scheduleTimer = null;
    }
  }

  startScheduleRunner(): void {
    this.stopScheduleRunner();
    // Check every 60 seconds for scheduled automations
    this.scheduleTimer = setInterval(() => {
      void this.runScheduledAutomations();
    }, 60_000);
  }

  private async runScheduledAutomations(): Promise<void> {
    const db = this.db;
    if (!db) return;

    const now = new Date();

    for (const automation of this.automations.values()) {
      if (automation.triggerType !== "schedule") continue;
      if (!automation.enabled) continue;
      if (!automation.schedule?.cron) continue;

      if (!cronMatchesNow(automation.schedule.cron, now)) continue;

      // Prevent double-execution within the same minute
      if (automation.lastScheduledAt) {
        const lastRun = new Date(automation.lastScheduledAt);
        if (
          lastRun.getFullYear() === now.getFullYear() &&
          lastRun.getMonth() === now.getMonth() &&
          lastRun.getDate() === now.getDate() &&
          lastRun.getHours() === now.getHours() &&
          lastRun.getMinutes() === now.getMinutes()
        ) {
          continue;
        }
      }

      // Create a synthetic event for the scheduled run
      const syntheticEvent = createEvent({
        type: "automation.scheduled",
        payload: {
          automationId: automation.id,
          automationName: automation.name,
          cron: automation.schedule.cron,
          scheduledAt: now.toISOString(),
        },
        source: "scheduler",
      });

      // Update last_scheduled_at
      automation.lastScheduledAt = now.toISOString();
      try {
        await db.query(
          `UPDATE workspace_automations SET last_scheduled_at = $1 WHERE id = $2`,
          [now.toISOString(), automation.id],
        );
      } catch {
        // silenced
      }

      // Execute the action
      try {
        const { status, result } = await executeAction(automation, syntheticEvent, db, this.apiUrl);
        await recordRun(db, automation.id, syntheticEvent.id, status, result);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        try {
          await recordRun(db, automation.id, syntheticEvent.id, "error", { error: message });
        } catch {
          // recording failure silenced
        }
      }
    }
  }
}

export type AutomationRow = {
  id: string;
  name: string;
  trigger_event_type: string;
  trigger_filter_json?: string | null;
  trigger_type: string;
  schedule_cron: string | null;
  schedule_timezone: string;
  last_scheduled_at: string | null;
  action_type: string;
  action_config_json: string;
  enabled: boolean;
  created_at: string;
  updated_at: string;
};

export function rowToAutomation(row: AutomationRow): Automation {
  const config = JSON.parse(row.action_config_json);
  let action: AutomationAction;

  switch (row.action_type) {
    case "webhook":
      action = { type: "webhook", url: config.url, headers: config.headers, method: config.method };
      break;
    case "create_task":
      action = { type: "create_task", title: config.title, assignedTo: config.assignedTo };
      break;
    case "execute_task":
      action = { type: "execute_task", prompt: config.prompt, recipientAgentId: config.recipientAgentId, reasoningEffort: config.reasoningEffort };
      break;
    case "execute_background_task":
      action = { type: "execute_background_task", prompt: config.prompt, recipientAgentId: config.recipientAgentId, reasoningEffort: config.reasoningEffort };
      break;
    case "log":
      action = { type: "log", message: config.message };
      break;
    default:
      action = { type: "log", message: `Unknown action type: ${row.action_type}` };
  }

  const triggerType = (row.trigger_type === "schedule" ? "schedule" : "event") as "event" | "schedule";

  return {
    id: row.id,
    name: row.name,
    triggerType,
    trigger: {
      eventType: row.trigger_event_type,
    },
    schedule: triggerType === "schedule" && row.schedule_cron
      ? { cron: row.schedule_cron, timezone: row.schedule_timezone || "UTC" }
      : undefined,
    action,
    enabled: row.enabled,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastScheduledAt: row.last_scheduled_at ?? undefined,
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
