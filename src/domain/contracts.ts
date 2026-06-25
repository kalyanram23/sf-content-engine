import { z } from "zod";

import { severitySchema, thinPlanSchema } from "./schemas";

/**
 * Strict LLM request/response contracts. These are SEPARATE from EngineState and the
 * domain value objects (DECISIONS D2): each describes one model response and must be
 * convertible to a strict JSON Schema (`additionalProperties:false`) for OpenRouter
 * structured outputs (D11). Keep them free of unions/refinements that strict mode can't
 * express.
 */

/** What the planner LLM returns — the thin plan (spec §5.4). */
export const planResponseSchema = thinPlanSchema;
export type PlanResponse = z.infer<typeof planResponseSchema>;

/** A single critic finding, keyed to a rubric dimension id (spec §5.6 vision pass). */
export const critiqueFindingSchema = z.object({
  /** Rubric dimension id (e.g. "balance", "hierarchy"). */
  dimension: z.string().min(1),
  severity: severitySchema,
  /** The critic's layout-vs-content hint (spec §5.6). */
  tag: z.enum(["layout", "content"]),
  region: z.string(),
  message: z.string(),
});
export type CritiqueFinding = z.infer<typeof critiqueFindingSchema>;

/** The vision critic's structured rubric response (spec §5.6). */
export const critiqueResponseSchema = z.object({
  findings: z.array(critiqueFindingSchema),
});
export type CritiqueResponse = z.infer<typeof critiqueResponseSchema>;

/** What an LLM-backed repair returns: the patched HTML only (D13). */
export const repairResponseSchema = z.object({
  html: z.string().min(1),
  note: z.string(),
});
export type RepairResponse = z.infer<typeof repairResponseSchema>;
