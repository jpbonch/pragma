import { z } from "zod";
import { TASK_STATUS_VALUES } from "../conversation/types";
import { getRegisteredHarnessIds } from "../conversation/adapterRegistry";

const harnessSchema = z.string().trim().min(1).refine(
  (value) => getRegisteredHarnessIds().includes(value),
  { message: "Unknown harness" },
);
const reasoningEffortSchema = z.enum(["low", "medium", "high", "extra_high"]);
const taskStatusSchema = z.enum(TASK_STATUS_VALUES);

const nonEmptyString = z.string().trim().min(1);

const positiveIntegerString = z
  .string()
  .regex(/^\d+$/)
  .transform((value) => Number.parseInt(value, 10))
  .refine((value) => Number.isInteger(value) && value > 0, "Must be a positive integer.");

export const createWorkspaceSchema = z
  .object({
    name: nonEmptyString,
    orchestrator_harness: harnessSchema,
  })
  .strict();

export const setActiveWorkspaceSchema = z
  .object({
    name: nonEmptyString,
  })
  .strict();

export const createAgentSchema = z
  .object({
    name: nonEmptyString,
    description: z.string().optional(),
    agent_file: z.string(),
    emoji: nonEmptyString,
    harness: harnessSchema,
    model_label: nonEmptyString,
  })
  .strict();

export const updateAgentSchema = z
  .object({
    name: nonEmptyString,
    description: z.string().optional(),
    agent_file: z.string(),
    emoji: nonEmptyString,
    harness: harnessSchema,
    model_label: nonEmptyString,
  })
  .strict();

export const tasksQuerySchema = z
  .object({
    status: taskStatusSchema.optional(),
    limit: positiveIntegerString,
  })
  .strict();

export const createTaskSchema = z
  .object({
    title: nonEmptyString,
    status: taskStatusSchema,
    assigned_to: nonEmptyString.optional(),
    output_dir: nonEmptyString.optional(),
    session_id: nonEmptyString.optional(),
  })
  .strict();

export const createExecuteTaskSchema = z
  .object({
    prompt: nonEmptyString,
    recipient_agent_id: nonEmptyString.optional(),
    reasoning_effort: reasoningEffortSchema,
  })
  .strict();

export const createFollowupTaskSchema = z
  .object({
    prompt: nonEmptyString,
    recipient_agent_id: nonEmptyString.optional(),
    reasoning_effort: reasoningEffortSchema,
  })
  .strict();

export const setTaskRecipientSchema = z
  .object({
    recipient_agent_id: nonEmptyString,
  })
  .strict();

export const agentSelectRecipientSchema = z
  .object({
    agent_id: nonEmptyString,
    reason: nonEmptyString,
    turn_id: nonEmptyString.optional(),
  })
  .strict();

export const planSelectRecipientSchema = z
  .object({
    agent_id: nonEmptyString,
    reason: nonEmptyString,
  })
  .strict();

export const planProposeSchema = z
  .object({
    tasks: z
      .array(
        z.object({
          title: z.string().trim().min(1),
          prompt: z.string().trim().min(1),
          recipient: z.string().trim().min(1),
        }).strict(),
      )
      .min(1)
      .max(20),
  })
  .strict();

export const executePlanProposalSchema = z
  .object({
    tasks: z
      .array(
        z.object({
          title: z.string().trim().min(1),
          prompt: z.string().trim().min(1),
          recipient_agent_id: z.string().trim().min(1),
        }).strict(),
      )
      .min(1)
      .max(20),
    reasoning_effort: reasoningEffortSchema,
  })
  .strict();

export const agentAskQuestionSchema = z
  .object({
    question: nonEmptyString,
    details: nonEmptyString.optional(),
    options: z.array(nonEmptyString).max(6).optional(),
    turn_id: nonEmptyString.optional(),
    agent_id: nonEmptyString.optional(),
  })
  .strict();

export const agentRequestHelpSchema = z
  .object({
    summary: nonEmptyString,
    details: nonEmptyString.optional(),
    turn_id: nonEmptyString.optional(),
    agent_id: nonEmptyString.optional(),
  })
  .strict();

export const taskRespondSchema = z
  .object({
    message: nonEmptyString,
  })
  .strict();

export const stopTaskSchema = z
  .object({
    message: nonEmptyString.optional(),
  })
  .strict();

export const reviewTaskSchema = z
  .object({
    action: z.enum(["approve", "approve_and_push", "reopen", "mark_completed", "approve_chain", "approve_chain_and_push", "mark_chain_completed"]),
    message: nonEmptyString.optional(),
  })
  .strict();

export const openOutputFolderSchema = z
  .object({
    path: nonEmptyString.optional(),
  })
  .strict();

export const outputFileQuerySchema = z
  .object({
    path: nonEmptyString,
  })
  .strict();

export const conversationTurnSchema = z
  .object({
    thread_id: nonEmptyString.optional(),
    message: nonEmptyString,
    mode: z.enum(["chat", "plan"]),
    harness: harnessSchema,
    model_label: nonEmptyString,
    recipient_agent_id: nonEmptyString.optional(),
    reasoning_effort: reasoningEffortSchema,
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.mode !== "plan" && value.recipient_agent_id !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["recipient_agent_id"],
        message: "recipient_agent_id is only allowed in plan mode.",
      });
    }
  });

export const executeFromThreadSchema = z
  .object({
    recipient_agent_id: nonEmptyString.optional(),
    reasoning_effort: reasoningEffortSchema,
  })
  .strict();

export const chatsQuerySchema = z
  .object({
    limit: positiveIntegerString,
    cursor: nonEmptyString.optional(),
  })
  .strict();

export const plansQuerySchema = z
  .object({
    limit: positiveIntegerString,
    cursor: nonEmptyString.optional(),
  })
  .strict();

export const createContextFolderSchema = z
  .object({
    name: nonEmptyString,
  })
  .strict();

export const createCodeRepoCloneSchema = z
  .object({
    git_url: nonEmptyString,
  })
  .strict();

export const createCodeFolderCopySchema = z
  .object({
    local_path: nonEmptyString,
  })
  .strict();

export const serviceStdinSchema = z.object({
  text: nonEmptyString,
}).strict();

export const createContextFileSchema = z
  .object({
    name: nonEmptyString,
    folder: nonEmptyString.optional(),
  })
  .strict();

export const updateContextFileSchema = z
  .object({
    path: nonEmptyString,
    content: z.string(),
  })
  .strict();

export const createHumanSchema = z
  .object({
    emoji: nonEmptyString,
  })
  .strict();

export const updateHumanSchema = z
  .object({
    emoji: nonEmptyString,
  })
  .strict();

export const createSkillSchema = z
  .object({
    name: nonEmptyString,
    description: z.string().optional(),
    content: nonEmptyString,
  })
  .strict();

export const updateSkillSchema = z
  .object({
    name: nonEmptyString.optional(),
    description: z.string().optional(),
    content: nonEmptyString.optional(),
  })
  .strict();

export const assignAgentSkillSchema = z
  .object({
    skill_id: nonEmptyString,
  })
  .strict();

export const configureConnectorSchema = z
  .object({
    oauth_client_id: z.string().optional(),
    oauth_client_secret: z.string().optional(),
    access_token: z.string().optional(),
  })
  .strict();

export const createCustomConnectorSchema = z
  .object({
    name: nonEmptyString,
    description: z.string().optional(),
    content: nonEmptyString,
    auth_type: z.enum(["oauth2", "api_key"]),
    // OAuth fields (required when auth_type is oauth2)
    oauth_client_id: z.string().optional(),
    oauth_client_secret: z.string().optional(),
    oauth_auth_url: z.string().optional(),
    oauth_token_url: z.string().optional(),
    scopes: z.string().optional(),
    // API key field (required when auth_type is api_key)
    access_token: z.string().optional(),
  })
  .strict();

export const updateCustomConnectorSchema = z
  .object({
    name: nonEmptyString.optional(),
    description: z.string().optional(),
    content: nonEmptyString.optional(),
    auth_type: z.enum(["oauth2", "api_key"]).optional(),
    oauth_client_id: z.string().optional(),
    oauth_client_secret: z.string().optional(),
    oauth_auth_url: z.string().optional(),
    oauth_token_url: z.string().optional(),
    scopes: z.string().optional(),
    access_token: z.string().optional(),
  })
  .strict();

export const assignAgentConnectorSchema = z
  .object({
    connector_id: nonEmptyString,
  })
  .strict();

export const dbQuerySchema = z
  .object({
    sql: z.string().trim().min(1),
    params: z.array(z.unknown()).optional(),
  })
  .strict();

const processTypeSchema = z.enum(["service", "script"]);

export const createProcessSchema = z
  .object({
    label: nonEmptyString,
    command: nonEmptyString,
    cwd: nonEmptyString,
    type: processTypeSchema,
  })
  .strict();

export const updateProcessSchema = z
  .object({
    label: nonEmptyString.optional(),
    command: nonEmptyString.optional(),
    cwd: nonEmptyString.optional(),
    type: processTypeSchema.optional(),
  })
  .strict();

const automationActionTypeSchema = z.enum(["webhook", "create_task", "execute_task", "log"]);

const automationTriggerTypeSchema = z.enum(["event", "schedule"]);

const automationTriggerSchema = z
  .object({
    eventType: nonEmptyString,
  })
  .strict();

const automationScheduleSchema = z
  .object({
    cron: nonEmptyString,
    timezone: z.string().trim().optional(),
  })
  .strict();

const webhookActionSchema = z
  .object({
    type: z.literal("webhook"),
    url: z.string().trim().url(),
    headers: z.record(z.string(), z.string()).optional(),
    method: z.string().trim().optional(),
  })
  .strict();

const createTaskActionSchema = z
  .object({
    type: z.literal("create_task"),
    title: nonEmptyString,
    assignedTo: nonEmptyString.optional(),
  })
  .strict();

const executeTaskActionSchema = z
  .object({
    type: z.literal("execute_task"),
    prompt: nonEmptyString,
    recipientAgentId: nonEmptyString.optional(),
    reasoningEffort: reasoningEffortSchema.optional().default("high"),
  })
  .strict();

const logActionSchema = z
  .object({
    type: z.literal("log"),
    message: z.string().optional(),
  })
  .strict();

const automationActionSchema = z.discriminatedUnion("type", [
  webhookActionSchema,
  createTaskActionSchema,
  executeTaskActionSchema,
  logActionSchema,
]);

export const createAutomationSchema = z
  .object({
    name: nonEmptyString,
    triggerType: automationTriggerTypeSchema.optional(),
    trigger: automationTriggerSchema.optional(),
    schedule: automationScheduleSchema.optional(),
    action: automationActionSchema,
    enabled: z.boolean().optional(),
  })
  .strict()
  .refine(
    (data) => {
      if (data.triggerType === "schedule") {
        return !!data.schedule?.cron;
      }
      return !!data.trigger?.eventType;
    },
    { message: "Event automations require a trigger; schedule automations require a schedule with a cron expression." },
  );

export const updateAutomationSchema = z
  .object({
    name: nonEmptyString.optional(),
    triggerType: automationTriggerTypeSchema.optional(),
    trigger: automationTriggerSchema.optional(),
    schedule: automationScheduleSchema.optional(),
    action: automationActionSchema.optional(),
    enabled: z.boolean().optional(),
  })
  .strict();

export const queryEventsSchema = z
  .object({
    type: z.string().trim().optional(),
    taskId: z.string().trim().optional(),
    since: z.string().trim().optional(),
    limit: positiveIntegerString.optional(),
  })
  .strict();

export const automationRunsQuerySchema = z
  .object({
    limit: positiveIntegerString.optional(),
  })
  .strict();

export type Harness = z.infer<typeof harnessSchema>;
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type TaskStatus = z.infer<typeof taskStatusSchema>;
