import { randomBytes } from "node:crypto";

export interface PragmaEvent {
  id: string;
  type: string;
  timestamp: string;
  taskId?: string;
  threadId?: string;
  turnId?: string;
  workspaceName?: string;
  payload: Record<string, any>;
  source: string;
}

export const EVENT_TYPES = {
  TASK_CREATED: "task.created",
  TASK_STATUS_CHANGED: "task.status_changed",
  TASK_COMPLETED: "task.completed",
  TASK_FAILED: "task.failed",
  TASK_REOPENED: "task.reopened",
  PLAN_PROPOSED: "plan.proposed",
  PLAN_APPROVED: "plan.approved",
  PLAN_REJECTED: "plan.rejected",
  THREAD_CREATED: "thread.created",
  THREAD_UPDATED: "thread.updated",
  THREAD_MESSAGE_ADDED: "thread.message_added",
  AGENT_SPAWNED: "agent.spawned",
  AGENT_COMPLETED: "agent.completed",
  WORKER_SUBMITTED: "worker.submitted",
  ERROR: "error",
} as const;

type EventHandler = (event: PragmaEvent) => void;

function matchesPattern(pattern: string, eventType: string): boolean {
  if (pattern === "*") return true;
  if (pattern.endsWith(".*")) {
    const prefix = pattern.slice(0, -1);
    return eventType.startsWith(prefix);
  }
  return pattern === eventType;
}

export class EventBus {
  private static instance: EventBus;
  private handlers = new Map<string, Set<EventHandler>>();
  private persistFn: ((event: PragmaEvent) => Promise<void>) | null = null;

  private constructor() {}

  static getInstance(): EventBus {
    if (!EventBus.instance) {
      EventBus.instance = new EventBus();
    }
    return EventBus.instance;
  }

  setPersistFn(fn: (event: PragmaEvent) => Promise<void>): void {
    this.persistFn = fn;
  }

  emit(event: PragmaEvent): void {
    for (const [pattern, handlers] of this.handlers) {
      if (matchesPattern(pattern, event.type)) {
        for (const handler of handlers) {
          Promise.resolve().then(() => {
            try {
              handler(event);
            } catch (_err) {
              // handler error silenced
            }
          });
        }
      }
    }

    if (this.persistFn) {
      const fn = this.persistFn;
      Promise.resolve().then(() => fn(event).catch(() => {}));
    }
  }

  on(eventType: string, handler: EventHandler): () => void {
    let handlers = this.handlers.get(eventType);
    if (!handlers) {
      handlers = new Set();
      this.handlers.set(eventType, handlers);
    }
    handlers.add(handler);

    return () => {
      handlers!.delete(handler);
      if (handlers!.size === 0) {
        this.handlers.delete(eventType);
      }
    };
  }

  once(eventType: string, handler: EventHandler): () => void {
    const wrappedHandler: EventHandler = (event) => {
      unsubscribe();
      handler(event);
    };
    const unsubscribe = this.on(eventType, wrappedHandler);
    return unsubscribe;
  }

  removeAllListeners(eventType?: string): void {
    if (eventType !== undefined) {
      this.handlers.delete(eventType);
    } else {
      this.handlers.clear();
    }
  }
}

export function createEvent(
  fields: Omit<PragmaEvent, "id" | "timestamp"> & { id?: string; timestamp?: string },
): PragmaEvent {
  return {
    id: fields.id ?? `evt_${randomBytes(12).toString("hex")}`,
    timestamp: fields.timestamp ?? new Date().toISOString(),
    type: fields.type,
    taskId: fields.taskId,
    threadId: fields.threadId,
    turnId: fields.turnId,
    workspaceName: fields.workspaceName,
    payload: fields.payload,
    source: fields.source,
  };
}
