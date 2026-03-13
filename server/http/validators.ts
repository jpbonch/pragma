import { zValidator } from "@hono/zod-validator";
import type { Context } from "hono";
import type { ZodIssue, ZodSchema } from "zod";

function formatIssue(issue: ZodIssue): { path: string; code: string; message: string } {
  return {
    path: issue.path.length > 0 ? issue.path.join(".") : "$",
    code: issue.code,
    message: issue.message,
  };
}

function validationErrorResponse(c: Context, issues: ZodIssue[]): Response {
  return c.json(
    {
      error: "VALIDATION_ERROR",
      message: "Request validation failed.",
      details: issues.map(formatIssue),
    },
    422,
  );
}

export function validateJson<T extends ZodSchema>(schema: T) {
  return zValidator("json", schema, (result, c) => {
    if (!result.success) {
      return validationErrorResponse(c, result.error.issues);
    }
  });
}

export function validateQuery<T extends ZodSchema>(schema: T) {
  return zValidator("query", schema, (result, c) => {
    if (!result.success) {
      return validationErrorResponse(c, result.error.issues);
    }
  });
}
