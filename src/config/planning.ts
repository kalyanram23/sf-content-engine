import { z } from "zod";

import { deepFreeze } from "../util/freeze";

/**
 * Planning fit config (rules-as-data). The single source of truth for how many items/rows a board
 * can hold at ~10–20 ft — used by the elastic screen-count arithmetic in `expandLayoutToPlan`, the
 * `screens:"auto"` items-per-board target, and the over-budget sizing regime (D26). Formerly the
 * hardcoded `LEGIBILITY_BUDGET = 24` (coverage) and the contradictory `AUTO_ITEMS_PER_SCREEN = 40`
 * (planner); both now derive from `legibilityBudget`.
 */
export const planningConfigSchema = z.object({
  /**
   * Items per board beyond which a screen reads as cramped at ~10–20 ft. Also the elastic-fit
   * budget (matrix ROWS count as rows, since paired items share a line), the `screens:"auto"`
   * items-per-board target, and the comfortable single-column budget beyond which the sizing
   * directive enters its two-column over-budget regime (D26). Kept at 24 (the legacy budget).
   */
  legibilityBudget: z.number().int().positive().default(24),
  /**
   * Boards below this many items read as under-filled dead space; the elastic planner LOWERS the
   * requested screen count toward the fit minimum (never below 1) rather than ship sparse boards.
   */
  minItemsPerBoard: z.number().int().positive().default(4),
  /**
   * How the requested screen count is honoured (D26). `"elastic"` (default, back-compat): the
   * count is a hint the fit arithmetic may raise to fit the budget or lower when boards would be
   * sparse. `"exact"`: the count is law — capped only by the number of sections, because
   * categories are atomic and never split across screens (D25).
   */
  screensMode: z.enum(["exact", "elastic"]).default("elastic"),
  /**
   * Multiplier on `legibilityBudget` that splits the two over-budget density tiers (D30). Tier
   * classification is COLUMN-AWARE (D70): a board stays `comfortable` while its rows fit the
   * budget PER COLUMN at the sizing ladder's own column choice (≤ budget in one column, or ≤
   * budget per column in two — i.e. up to 2×budget raw rows); beyond that it is `dense` up to
   * `packedMultiplier × legibilityBudget` and `packed` past it. With the default of 2 the dense
   * band is empty (two comfortable columns hold exactly 2×budget), so default-config boards
   * classify comfortable or packed; raise the multiplier above 2 to reopen a dense band. The
   * painter drops to a progressively more compact price-list idiom per tier and the critic judges
   * each against that register.
   */
  packedMultiplier: z.number().min(1).default(2),
});

export type PlanningConfig = z.infer<typeof planningConfigSchema>;

export const defaultPlanningConfig = (): PlanningConfig =>
  deepFreeze(planningConfigSchema.parse({}));
