import { ValidationError } from "../../domain/errors";
import type { GenerateInput, ThinPlan } from "../../domain/types";
import type { Planner } from "../../ports/planner";

/**
 * Returns a hand-authored plan (v1, spec §5.4 — isolates paint + loop from the planner). The
 * LLM planner is a later slice (§8). Prefers a plan on the input, else the construction one.
 */
export class StaticPlanner implements Planner {
  constructor(private readonly fixedPlan?: ThinPlan) {}

  plan(input: GenerateInput): Promise<ThinPlan> {
    const plan = input.plan ?? this.fixedPlan;
    if (!plan) {
      throw new ValidationError(
        "StaticPlanner needs a plan: pass one to the constructor or include `plan` on the input (v1).",
      );
    }
    return Promise.resolve(plan);
  }
}
