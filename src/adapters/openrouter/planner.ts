import type OpenAI from "openai";

import { planLayoutSchema, type PlanLayout } from "../../domain/contracts";
import type { GenerateInput, ThinPlan } from "../../domain/types";
import type { Planner } from "../../ports/planner";
import type { Logger } from "../../ports/services";
import { buildMenuDigest, expandLayoutToPlan } from "../../planning/coverage";
import { requestStructured } from "./client";

/** When `constraints.screens` is "auto", aim for roughly this many items per board. */
const AUTO_ITEMS_PER_SCREEN = 40;

const SYSTEM = `You are a layout planner for digital-signage menu screens. Given a menu summarised BY CATEGORY and a target number of screens, you decide how to lay the menu out — but you NEVER list individual item ids; you work at the category level. Deterministic code expands your plan to the real items and guarantees every item appears, so focus purely on grouping, ordering, and representation judgment.

Return JSON matching the schema: an ordered list of "blocks". Each block has:
- title: the heading shown on screen (e.g. "Biryani & Pulav", "Veg Curries").
- categories: one or more EXACT category names from the digest whose items fill this block.
- representation: one of "matrix", "variant-rows", "grid", "list".
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
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
    private readonly logger?: Logger,
  ) {}

  async plan(input: GenerateInput): Promise<ThinPlan> {
    const screens = resolveScreenCount(input);
    const digest = buildMenuDigest(input.items);
    const layout = await requestStructured<PlanLayout>(this.client, {
      model: this.model,
      schema: planLayoutSchema,
      schemaName: "plan_layout",
      system: SYSTEM,
      user: describePlanRequest(digest, input, screens),
    });
    this.logger?.info(
      `planner: ${layout.blocks.length} block(s) over ${input.items.length} items → ${screens} screen(s)`,
    );
    return expandLayoutToPlan(layout, input.items, screens, {
      warn: (message) => this.logger?.warn(message),
    });
  }
}

function resolveScreenCount(input: GenerateInput): number {
  const requested = input.constraints.screens;
  if (typeof requested === "number") return requested;
  return Math.max(1, Math.ceil(input.items.length / AUTO_ITEMS_PER_SCREEN));
}

function describePlanRequest(
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
