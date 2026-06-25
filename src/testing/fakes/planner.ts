import { ValidationError } from "../../domain/errors";
import type { GenerateInput, ThinPlan } from "../../domain/types";
import type { Planner } from "../../ports/planner";

/**
 * A planner that returns a fixed, hand-authored plan (v1, spec §5.4). Prefers the plan on
 * the input if present, else the one supplied at construction.
 */
export class FakePlanner implements Planner {
  constructor(private readonly fixedPlan?: ThinPlan) {}

  plan(input: GenerateInput): Promise<ThinPlan> {
    const plan = input.plan ?? this.fixedPlan;
    if (!plan) {
      throw new ValidationError(
        "FakePlanner has no plan: pass one to the constructor or on the input.",
      );
    }
    return Promise.resolve(plan);
  }
}
