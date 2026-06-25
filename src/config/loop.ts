import { z } from "zod";

import { deepFreeze } from "../util/freeze";

/** QA correction loop control (spec §5.6). */
export const loopConfigSchema = z.object({
  /** Bounded 2–3 iterations; budget exhausted → ship best-scoring, flagged. */
  maxIterations: z.number().int().positive().default(3),
});

export type LoopConfig = z.infer<typeof loopConfigSchema>;

export const defaultLoopConfig = (): LoopConfig => deepFreeze(loopConfigSchema.parse({}));
