import type { GenerateInput, ThinPlan } from "../domain/types";

/**
 * Produces the thin plan (content allocation + representation hints, spec §5.4) from the
 * menu. v1's adapter returns a hand-authored plan; an LLM planner is a later slice (§8).
 */
export interface Planner {
  plan(input: GenerateInput): Promise<ThinPlan>;
}
