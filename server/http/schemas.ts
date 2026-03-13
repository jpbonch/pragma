import { z } from "zod";
import { JOB_STATUS_VALUES } from "../conversation/types";

const harnessSchema = z.enum(["codex", "claude_code"]);
const reasoningEffortSchema = z.enum(["low", "medium", "high", "extra_high"]);
const jobStatusSchema = z.enum(JOB_STATUS_VALUES);

const nonEmptyString = z.string().trim().min(1);

const positiveIntegerString = z
  .string()
  .regex(/^\d+$/)
  .transform((value) => Number.parseInt(value, 10))
  .refine((value) => Number.isInteger(value) && value > 0, "Must be a positive integer.");

export const createWorkspaceSchema = z
  .object({
    name: nonEmptyString,
    goal: nonEmptyString,
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
    agent_file: z.string(),
    emoji: nonEmptyString,
    harness: harnessSchema,
    model_label: nonEmptyString,
  })
  .strict();

export const updateAgentSchema = z
  .object({
    name: nonEmptyString,
    agent_file: z.string(),
    emoji: nonEmptyString,
    harness: harnessSchema,
    model_label: nonEmptyString,
  })
  .strict();

export const jobsQuerySchema = z
  .object({
    status: jobStatusSchema.optional(),
    limit: positiveIntegerString,
  })
  .strict();

export const createJobSchema = z
  .object({
    title: nonEmptyString,
    status: jobStatusSchema,
    assigned_to: nonEmptyString.optional(),
    output_dir: nonEmptyString.optional(),
    session_id: nonEmptyString.optional(),
  })
  .strict();

export const createExecuteJobSchema = z
  .object({
    prompt: nonEmptyString,
    recipient_agent_id: nonEmptyString.optional(),
    reasoning_effort: reasoningEffortSchema,
  })
  .strict();

export const setJobRecipientSchema = z
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

export const agentAskQuestionSchema = z
  .object({
    question: nonEmptyString,
    details: nonEmptyString.optional(),
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

export const agentSubmitTestCommandsSchema = z
  .object({
    commands: z
      .array(
        z
          .object({
            label: nonEmptyString,
            command: nonEmptyString,
            cwd: nonEmptyString,
          })
          .strict(),
      )
      .min(1),
    turn_id: nonEmptyString.optional(),
    agent_id: nonEmptyString.optional(),
  })
  .strict();

export const jobRespondSchema = z
  .object({
    message: nonEmptyString,
  })
  .strict();

export const planSummarySchema = z
  .object({
    title: nonEmptyString,
    summary: nonEmptyString,
    steps: z.array(nonEmptyString).min(1),
  })
  .strict();

export const reviewJobSchema = z
  .object({
    action: z.enum(["approve", "reopen"]),
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

export const runJobTestCommandSchema = z
  .object({
    command: nonEmptyString,
    cwd: nonEmptyString,
  })
  .strict();

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

export type Harness = z.infer<typeof harnessSchema>;
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;
export type JobStatus = z.infer<typeof jobStatusSchema>;
