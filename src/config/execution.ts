import { z } from "zod";

import { deepFreeze } from "../util/freeze";

/**
 * Engine execution controls. `boardConcurrency` is how many boards' QA loops run at once.
 * DEFAULT 1 (fully sequential) — the scripted-fake e2e tests consume browser/critic
 * observations in call order, so parallel boards would scramble them; and each real
 * Playwright render launches its own Chromium, so raising this trades memory for wall-clock.
 * Each board is an independent graph invocation (own thread/checkpointer/best), so >1 is safe.
 */
export const executionConfigSchema = z.object({
  boardConcurrency: z.number().int().positive().default(1),
});

export type ExecutionConfig = z.infer<typeof executionConfigSchema>;

export const defaultExecutionConfig = (): ExecutionConfig =>
  deepFreeze(executionConfigSchema.parse({}));
