import { randomUUID } from "node:crypto";
import { readdir } from "node:fs/promises";
import { getConversationAdapter } from "./adapters";
import { buildPrompt } from "./prompts";
import {
  completeTurn,
  ensureConversationSchema,
  failTurn,
  getThreadById,
  insertEvent,
  insertMessage,
  updateChatThreadMetadata,
  updateThreadSession,
} from "./store";
import type { ConversationMode, HarnessId, ReasoningEffort, TaskStatus } from "./types";
import { DEFAULT_AGENT_ID, getWorkspacePaths, openDatabase } from "../db";

type TurnInput = {
  workspaceName: string;
  threadId: string;
  turnId: string;
  userMessageId: string;
  isNewThread: boolean;
  message: string;
  mode: ConversationMode;
  harness: HarnessId;
  modelLabel: string;
  modelId: string;
  reasoningEffort?: ReasoningEffort;
  requestedRecipientAgentId?: string | null;
};

type TurnRunnerCallbacks = {
  apiUrl: string;
  pragmaCliCommand: string;
  onThreadUpdated?: (input: { workspaceName: string; threadId: string; source: string }) => void | Promise<void>;
  onTaskStatusChanged?: (input: {
    workspaceName: string;
    taskId: string;
    threadId: string;
    status: string;
    source: string;
  }) => void | Promise<void>;
  getAgentRow: (
    db: Awaited<ReturnType<typeof openDatabase>>,
    id: string,
  ) => Promise<{ id: string; name: string; harness: HarnessId; model_label: string; model_id: string; agent_file: string | null } | null>;
  listPlanWorkerCandidates: (
    db: Awaited<ReturnType<typeof openDatabase>>,
  ) => Promise<Array<{ id: string; name: string; description: string | null; harness: HarnessId; model_label: string }>>;
  isDirectoryEmpty: (path: string) => Promise<boolean>;
  getStoredPlanRecipientForTurn: (
    db: Awaited<ReturnType<typeof openDatabase>>,
    turnId: string,
  ) => Promise<string | null>;
  buildConversationAgentEnv: (input: {
    apiUrl: string;
    pragmaCliCommand: string;
    workspaceName: string;
    threadId: string;
    turnId: string;
    agentId: string;
    taskId?: string | null;
  }) => Record<string, string>;
  emitTaskStatus: (workspaceName: string, taskId: string, status: TaskStatus, source: string) => void;
};

// Active AbortControllers keyed by turnId, so we can cancel in-progress turns
const ACTIVE_TURN_ABORTS = new Map<string, AbortController>();

export class TurnRunner {
  private readonly callbacks: TurnRunnerCallbacks;

  constructor(callbacks: TurnRunnerCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Fire-and-forget: kicks off the turn in the background.
   * Returns immediately. The turn runs to completion (or failure)
   * independently of any client connection.
   */
  execute(input: TurnInput): void {
    runTurn(input, this.callbacks).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`Turn runner failed for ${input.turnId}: ${message}`);
    });
  }

  /**
   * Abort an in-progress turn. Returns true if a turn was found and aborted.
   */
  abort(turnId: string): boolean {
    const controller = ACTIVE_TURN_ABORTS.get(turnId);
    if (controller) {
      controller.abort();
      return true;
    }
    return false;
  }
}

async function runTurn(
  input: TurnInput,
  callbacks: TurnRunnerCallbacks,
): Promise<void> {
  const abortController = new AbortController();
  ACTIVE_TURN_ABORTS.set(input.turnId, abortController);

  const db = await openDatabase(input.workspaceName);
  await ensureConversationSchema(db);
  const paths = getWorkspacePaths(input.workspaceName);
  const adapter = getConversationAdapter(input.harness);

  const notifyThreadUpdated = async (source: string): Promise<void> => {
    await callbacks.onThreadUpdated?.({
      workspaceName: input.workspaceName,
      threadId: input.threadId,
      source,
    });
  };

  const insertThreadEvent = async (payload: {
    id: string;
    threadId: string;
    turnId: string | null;
    eventName: string;
    payload: unknown;
  }): Promise<void> => {
    await insertEvent(db, payload);
    await notifyThreadUpdated(payload.eventName);
  };

  try {
    const thread = await getThreadById(db, input.threadId);
    if (!thread) {
      throw new Error(`Thread not found: ${input.threadId}`);
    }

    // Emit thread_started event for new threads
    if (input.isNewThread) {
      const startedPayload = { thread_id: input.threadId };
      await insertThreadEvent({
        id: `evt_${randomUUID().slice(0, 12)}`,
        threadId: input.threadId,
        turnId: input.turnId,
        eventName: "thread_started",
        payload: startedPayload,
      });
    }

    // Emit user_message_saved event
    await insertThreadEvent({
      id: `evt_${randomUUID().slice(0, 12)}`,
      threadId: input.threadId,
      turnId: input.turnId,
      eventName: "user_message_saved",
      payload: { message_id: input.userMessageId },
    });

    // Build prompt
    let assistantText = "";
    const planPromptCandidates =
      input.mode === "plan" ? await callbacks.listPlanWorkerCandidates(db) : [];
    const workspaceIsEmpty =
      input.mode === "plan" ? await callbacks.isDirectoryEmpty(paths.codeDir) : false;
    const chatCodeRepos =
      input.mode === "chat"
        ? (await readdir(paths.codeDir, { withFileTypes: true }).catch(() => []))
            .filter((e) => e.isDirectory() && !e.name.startsWith("."))
            .map((e) => e.name)
            .sort()
        : [];
    const prompt = buildPrompt(input.mode, input.message, input.reasoningEffort, callbacks.pragmaCliCommand, {
      planCandidates: planPromptCandidates.map((candidate) => ({
        id: candidate.id,
        name: candidate.name,
        description: candidate.description,
        harness: candidate.harness,
        modelLabel: candidate.model_label,
      })),
      workspaceIsEmpty,
      workspaceDir: paths.workspaceDir,
      codeRepos: chatCodeRepos,
    });

    const result = await adapter.sendTurn({
      prompt,
      modelId: input.modelId,
      sessionId: thread.harness_session_id,
      cwd: paths.codeDir,
      env: callbacks.buildConversationAgentEnv({
        apiUrl: callbacks.apiUrl,
        pragmaCliCommand: callbacks.pragmaCliCommand,
        workspaceName: input.workspaceName,
        threadId: input.threadId,
        turnId: input.turnId,
        agentId: DEFAULT_AGENT_ID,
        taskId: thread.task_id,
      }),
      mode: input.mode,
      reasoningEffort: input.reasoningEffort,
      abortSignal: abortController.signal,
      onEvent: async (event) => {
        if (abortController.signal.aborted) return;
        if (event.type === "assistant_text") {
          assistantText = assistantText ? `${assistantText}\n${event.delta}` : event.delta;
          await insertThreadEvent({
            id: `evt_${randomUUID().slice(0, 12)}`,
            threadId: input.threadId,
            turnId: input.turnId,
            eventName: "assistant_text",
            payload: event,
          });
          return;
        }

        await insertThreadEvent({
          id: `evt_${randomUUID().slice(0, 12)}`,
          threadId: input.threadId,
          turnId: input.turnId,
          eventName: "tool_event",
          payload: event,
        });
      },
    });

    if (result.aborted) {
      const partialText = (result.finalText || assistantText || "").trim();
      await failTurn(db, input.turnId, "Turn aborted.");
      if (partialText) {
        await insertMessage(db, {
          id: `msg_${randomUUID().slice(0, 12)}`,
          threadId: input.threadId,
          turnId: input.turnId,
          role: "assistant",
          content: partialText,
        });
      }
      await insertThreadEvent({
        id: `evt_${randomUUID().slice(0, 12)}`,
        threadId: input.threadId,
        turnId: input.turnId,
        eventName: "turn_failed",
        payload: { turn_id: input.turnId, reason: "aborted" },
      });
      return;
    }

    const finalAssistantText = (result.finalText || assistantText || "").trim();
    const assistantMessageId = `msg_${randomUUID().slice(0, 12)}`;
    const selectedPlanRecipientAgentId =
      input.mode === "plan" ? await callbacks.getStoredPlanRecipientForTurn(db, input.turnId) : null;

    await completeTurn(db, {
      turnId: input.turnId,
      assistantMessage: finalAssistantText,
      selectedAgentId: selectedPlanRecipientAgentId,
      selectionStatus: input.mode === "plan"
        ? (selectedPlanRecipientAgentId ? "auto_selected" : "recipient_required")
        : null,
    });

    await insertMessage(db, {
      id: assistantMessageId,
      threadId: input.threadId,
      turnId: input.turnId,
      role: "assistant",
      content: finalAssistantText,
    });

    // Transition task from planning → planned when plan turn completes,
    // but only if the agent didn't ask a question during this turn.
    if (input.mode === "plan" && thread.task_id) {
      const currentTask = await db.query<{ status: string }>(
        `SELECT status FROM tasks WHERE id = $1 LIMIT 1`,
        [thread.task_id],
      );
      const currentStatus = currentTask.rows[0]?.status;
      if (currentStatus !== "waiting_for_question_response") {
        if (selectedPlanRecipientAgentId) {
          await db.query(
            `UPDATE tasks SET status = 'planned', plan = $2, assigned_to = $3 WHERE id = $1`,
            [thread.task_id, finalAssistantText, selectedPlanRecipientAgentId],
          );
        } else {
          await db.query(
            `UPDATE tasks SET status = 'planned', plan = $2 WHERE id = $1`,
            [thread.task_id, finalAssistantText],
          );
        }
        callbacks.emitTaskStatus(input.workspaceName, thread.task_id, "planned", "plan_completed");
      }
    }

    if (input.mode === "chat") {
      // Title generation is handled upstream (before the turn starts) so only
      // update the lastMessageAt timestamp here.
      await updateChatThreadMetadata(db, {
        threadId: input.threadId,
        lastMessageAt: new Date().toISOString(),
      });
    }

    await updateThreadSession(db, {
      threadId: input.threadId,
      sessionId: result.sessionId,
    });

    const turnCompletedPayload = {
      turn_id: input.turnId,
      assistant_message_id: assistantMessageId,
    };

    await insertThreadEvent({
      id: `evt_${randomUUID().slice(0, 12)}`,
      threadId: input.threadId,
      turnId: input.turnId,
      eventName: "turn_completed",
      payload: turnCompletedPayload,
    });
  } catch (error: unknown) {
    const messageText = error instanceof Error ? error.message : String(error);

    await failTurn(db, input.turnId, messageText);
    await insertThreadEvent({
      id: `evt_${randomUUID().slice(0, 12)}`,
      threadId: input.threadId,
      turnId: input.turnId,
      eventName: "error",
      payload: { code: "TURN_ERROR", message: messageText },
    });
  } finally {
    ACTIVE_TURN_ABORTS.delete(input.turnId);
    await db.close();
  }
}
