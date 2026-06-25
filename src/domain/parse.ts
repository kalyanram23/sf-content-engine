import type { z } from "zod";

import { ValidationError } from "./errors";

/** Format Zod issues into a compact, human-readable single line. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}

/**
 * Parse `value` with `schema`, throwing a structured {@link ValidationError} (never a raw
 * ZodError) on failure. Use at every boundary (build brief: validate inputs, no silent
 * failures).
 */
export function parseOrThrow<T extends z.ZodType>(
  schema: T,
  value: unknown,
  what: string,
): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ValidationError(`Invalid ${what}: ${formatIssues(result.error)}`, {
      cause: result.error,
      details: { issues: result.error.issues },
    });
  }
  return result.data;
}
