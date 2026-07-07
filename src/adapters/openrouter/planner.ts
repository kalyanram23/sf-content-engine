import type OpenAI from "openai";

import type { ReasoningSetting } from "../../config/models";
import type { PlanningConfig } from "../../config/planning";
import { viewportForAspect } from "../../config/qa";
import { planLayoutSchema, type PlanLayout } from "../../domain/contracts";
import type { GenerateInput, ThinPlan } from "../../domain/types";
import type { RequestCorrelation } from "../../ports/correlation";
import type { Planner } from "../../ports/planner";
import type { Logger, UsageSink } from "../../ports/services";
import { buildMenuDigest, expandLayoutToPlan } from "../../planning/coverage";
import {
  buildUsageReporter,
  requestStructured,
  resilienceFields,
  type RoleResilience,
} from "./client";
import { buildBroadcast } from "./correlation";

/** Fit defaults when no planning config is threaded (mirror `config.planning`). */
const DEFAULT_LEGIBILITY_BUDGET = 24;
const DEFAULT_MIN_ITEMS_PER_BOARD = 4;
const DEFAULT_PACKED_MULTIPLIER = 2;

export const SYSTEM = `You are a layout planner for digital-signage menu screens. Given a menu summarised BY CATEGORY and a target number of screens, you decide how to lay the menu out — but you NEVER list individual item ids; you work at the category level. Deterministic code expands your plan to the real items and guarantees every item appears, so focus purely on grouping, ordering, and representation judgment.

Return JSON matching the schema: an ordered list of "blocks". Each block has:
- title: the heading shown on screen (e.g. "Biryani & Pulav", "Veg Curries").
- categories: one or more EXACT category names from the digest whose items fill this block.
- representation: one of "matrix", "grid", "list".
- layoutHint: free-text direction for the painter, or "" when none.

Rules:
- COVER EVERY category from the digest exactly once across your blocks (each category in at most one block).
- Keep categories in roughly menu order; group related categories adjacently.
- Aim to BALANCE total item count across the target screens (downstream code packs your ordered blocks into the screens, so order matters).
- Pick the representation that fits the data: "grid" for small photo-rich categories, "list" for large/dense ones.
- COMBINE categories that share the SAME base dishes into ONE block using representation "matrix": detect this from the sample names — e.g. "Chicken Biryani"/"Paneer Biryani" in one category and "Chicken Pulav"/"Paneer Pulav" in another means Biryani and Pulav share base dishes. For such a block set layoutHint to describe the table, e.g. "price table: rows = shared base dish (Chicken, Paneer, Egg, Goat Kheema...), columns = Biryani | Pulav, each cell = that dish's price in that style".
- Honour the optional user direction if provided (it overrides your defaults).`;

/**
 * LLM coverage planner (D1, spec §8): one structured call returns a CATEGORY-LEVEL layout intent;
 * {@link expandLayoutToPlan} turns it into a coverage-guaranteed {@link ThinPlan}. Reliable because
 * the model's output is small and id-free — the bookkeeping (item ids, 100% coverage, packing into
 * the requested screen count) is deterministic.
 */
export class OpenRouterPlanner implements Planner {
  private readonly legibilityBudget: number;
  private readonly minItemsPerBoard: number;
  private readonly screensMode: PlanningConfig["screensMode"];
  private readonly packedMultiplier: number;

  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
    private readonly logger?: Logger,
    private readonly reasoning?: ReasoningSetting,
    private readonly maxTokens?: number,
    planning?: Partial<
      Pick<
        PlanningConfig,
        "legibilityBudget" | "minItemsPerBoard" | "screensMode" | "packedMultiplier"
      >
    >,
    private readonly resilience?: RoleResilience,
    private readonly usage?: UsageSink,
  ) {
    this.legibilityBudget = planning?.legibilityBudget ?? DEFAULT_LEGIBILITY_BUDGET;
    this.minItemsPerBoard = planning?.minItemsPerBoard ?? DEFAULT_MIN_ITEMS_PER_BOARD;
    this.screensMode = planning?.screensMode ?? "elastic";
    this.packedMultiplier = planning?.packedMultiplier ?? DEFAULT_PACKED_MULTIPLIER;
  }

  async plan(input: GenerateInput, correlation?: RequestCorrelation): Promise<ThinPlan> {
    const screens = resolveScreenCount(input, this.legibilityBudget);
    const digest = buildMenuDigest(input.items);
    const onUsage = buildUsageReporter(this.logger, this.usage, "plan", this.model);
    const layout = await requestStructured<PlanLayout>(this.client, {
      model: this.model,
      schema: planLayoutSchema,
      schemaName: "plan_layout",
      system: SYSTEM,
      user: describePlanRequest(digest, input, screens),
      ...(this.reasoning !== undefined ? { reasoning: this.reasoning } : {}),
      ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
      ...resilienceFields(this.resilience),
      ...(onUsage !== undefined ? { onUsage } : {}),
      ...buildBroadcast(correlation, "plan"),
    });
    this.logger?.info(
      `planner: ${layout.blocks.length} block(s) over ${input.items.length} items → hint ${screens} screen(s)`,
    );
    // In "elastic" mode `screens` is a HINT the fit arithmetic in expandLayoutToPlan flexes against
    // the per-board budget (tightened to the aspect's canvas) and the sparse floor (§ Phase 3); in
    // "exact" mode (D26) it is law, capped only by the section count (categories are atomic, D25).
    const { width, height } = viewportForAspect(input.constraints.aspect);
    return expandLayoutToPlan(layout, input.items, screens, {
      legibilityBudget: this.legibilityBudget,
      minItemsPerBoard: this.minItemsPerBoard,
      screensMode: this.screensMode,
      packedMultiplier: this.packedMultiplier,
      canvas: { width, height },
      logger: { warn: (message) => this.logger?.warn(message) },
    });
  }
}

/** The board-count HINT: a requested number is used as-is; "auto" derives from the fit budget. */
export function resolveScreenCount(input: GenerateInput, budget: number): number {
  const requested = input.constraints.screens;
  if (typeof requested === "number") return requested;
  return Math.max(1, Math.ceil(input.items.length / budget));
}

export function describePlanRequest(
  digest: ReturnType<typeof buildMenuDigest>,
  input: GenerateInput,
  screens: number,
): string {
  const lines = [
    `Target screens: ${screens}`,
    `Aspect: ${input.constraints.aspect} (${input.constraints.aspect === "9:16" ? "portrait" : "landscape"})`,
    `Menu by category (${digest.length} categories, ${input.items.length} items total):`,
    JSON.stringify(digest),
  ];
  const steer = input.brief.notes?.trim();
  if (steer) lines.push(`User direction (overrides defaults): ${steer}`);
  return lines.join("\n");
}
