import type { LayoutsConfig } from "../../config/layouts";
import type { PlanningConfig } from "../../config/planning";
import type {
  CanonicalItem,
  DensityTier,
  LayoutBlueprint,
  PlanScreen,
  ResolvedTheme,
  ThinPlan,
} from "../../domain/types";
import { mergeBlueprints, selectBlueprint } from "../../planning/layout-strategy";
import {
  comfortableRowBudget,
  computeTypeScale,
  densityTier,
  type TypeScaleDirective,
} from "../../planning/sizing";
import type { RequestCorrelation } from "../../ports/correlation";
import type { EngineState } from "../state";

/** The plan screen this run is painting (the engine loops the graph over every screen). */
export function currentScreen(plan: ThinPlan, index = 0): PlanScreen {
  const screen = plan.screens[index];
  if (!screen) throw new Error(`plan has no screen at index ${index}`);
  return screen;
}

/** The canonical items referenced by a screen (sections + image slot), de-duplicated. */
export function resolveScreenItems(
  screen: PlanScreen,
  all: readonly CanonicalItem[],
): CanonicalItem[] {
  const byId = new Map(all.map((i) => [i.id, i]));
  const ids = new Set<string>();
  for (const section of screen.sections) for (const id of section.items) ids.add(id);
  for (const id of screen.imageSlot?.items ?? []) ids.add(id);
  return [...ids].map((id) => byId.get(id)).filter((i): i is CanonicalItem => i !== undefined);
}

/**
 * The EFFECTIVE screen a paint/critique should reason about, given the RESOLVED items (post
 * `fetchImages`, where failed photo refs have been dropped): every image slot is filtered down to
 * items that still carry ≥1 image — so the painter never builds a carousel slide (and the critic
 * never expects one) for a photo that failed to fetch:
 *  • the board-level `imageSlot` (matrix hero / dense-packed shared) keeps only surviving photos, and
 *    is dropped entirely when none remain.
 *  • a per-section `"photos"` slot keeps only surviving photos; a slot that lost ALL its photos falls
 *    back to a `"icon"` panel so the category KEEPS its anchor (a food-icon panel — the product rule).
 * Section item COVERAGE is untouched (photo truth changes presentation, never coverage). Pure;
 * returns the input screen unchanged when nothing needs filtering.
 */
export function effectiveScreen(screen: PlanScreen, items: readonly CanonicalItem[]): PlanScreen {
  const withPhotos = new Set(items.filter((i) => (i.images?.length ?? 0) > 0).map((i) => i.id));

  // Per-section "photos" slots: drop failed photos; demote a fully-failed slot to a food-icon panel.
  let sectionsChanged = false;
  const nextSections = screen.sections.map((section) => {
    const s = section.imageSlot;
    if (s === undefined || s.kind !== "photos") return section;
    const kept = s.items.filter((id) => withPhotos.has(id));
    if (kept.length === s.items.length) return section;
    sectionsChanged = true;
    return {
      ...section,
      imageSlot:
        kept.length > 0
          ? { kind: "photos" as const, items: kept }
          : { kind: "icon" as const, items: [] },
    };
  });

  // Board-level slot: drop failed photos; remove the slot entirely when none survive.
  const slot = screen.imageSlot;
  const keptSlotItems = slot ? slot.items.filter((id) => withPhotos.has(id)) : [];
  const slotChanged = slot !== undefined && keptSlotItems.length !== slot.items.length;

  if (!sectionsChanged && !slotChanged) return screen;
  const withSections = sectionsChanged ? { ...screen, sections: nextSections } : screen;
  if (!slotChanged || slot === undefined) return withSections;

  // Rebuild without the slot (exactOptionalPropertyTypes — never `{ imageSlot: undefined }`).
  const { imageSlot: _dropped, ...rest } = withSections;
  return keptSlotItems.length > 0
    ? {
        ...rest,
        imageSlot: {
          ...(slot.categoryId !== undefined ? { categoryId: slot.categoryId } : {}),
          items: keptSlotItems,
        },
      }
    : rest;
}

/**
 * Resolve the layout blueprint for a board: merge the theme's per-theme overrides over the
 * engine catalog, then pick the highest-priority match (pure, deterministic). Shared by the
 * paint node (renders it as rails) and the vision node (grades against it) so both reason
 * about the same chosen layout.
 */
export function blueprintFor(
  screen: PlanScreen,
  items: readonly CanonicalItem[],
  theme: ResolvedTheme,
  layouts: LayoutsConfig,
): LayoutBlueprint {
  const merged = mergeBlueprints(layouts.blueprints, theme.layouts);
  return selectBlueprint(screen, items, merged);
}

/** A board's row count for sizing: matrix ROWS (paired items share a line) else the item count. */
export function boardRowCount(screen: PlanScreen): number {
  return screen.sections.reduce(
    (n, s) => n + (s.matrix ? s.matrix.rows.length : s.items.length),
    0,
  );
}

/**
 * The plan-time type-scale directive for a board on a given canvas (§ Phase 3 / D26). Computed the
 * SAME way for the painter, the vision critic AND the density evaluator, so all three reason about
 * identical target sizes (and the same over-budget judgment). `planning.legibilityBudget` sets the
 * comfortable single-column budget beyond which the two-column over-budget regime kicks in.
 */
export function typeScaleFor(
  screen: PlanScreen,
  viewport: { width: number; height: number },
  planning?: Pick<PlanningConfig, "legibilityBudget">,
): TypeScaleDirective {
  return computeTypeScale(
    boardRowCount(screen),
    viewport,
    undefined,
    planning?.legibilityBudget,
    screen.sections.length,
  );
}

/**
 * The plan-time type-scale directive TEXT for a board (painter prompt + critic context). See
 * {@link typeScaleFor} for the structured directive.
 */
export function sizeDirectiveFor(
  screen: PlanScreen,
  viewport: { width: number; height: number },
  planning?: Pick<PlanningConfig, "legibilityBudget">,
): string {
  return typeScaleFor(screen, viewport, planning).text;
}

/**
 * The board's density tier (D30) for a canvas: the tier stamped on the plan by `expandLayoutToPlan`
 * when present, else recomputed from the board's row count against the SAME per-canvas budget the
 * plan used — so a hand-authored plan (StaticPlanner, no stamp) classifies identically. Shared by
 * the painter (idiom switch), the vision critic (register + fair judging) and QA (legibility floor).
 */
export function densityTierFor(
  screen: PlanScreen,
  viewport: { width: number; height: number },
  planning?: Partial<Pick<PlanningConfig, "legibilityBudget" | "packedMultiplier">>,
): DensityTier {
  if (screen.densityTier !== undefined) return screen.densityTier;
  const budget = comfortableRowBudget(viewport, planning?.legibilityBudget);
  return densityTier(boardRowCount(screen), budget, planning?.packedMultiplier);
}

/** Unique canonical IDs allocated to a screen's sections (the binding contract surface). */
export function plannedSectionItemIds(screen: PlanScreen): string[] {
  const ids = new Set<string>();
  for (const section of screen.sections) for (const id of section.items) ids.add(id);
  return [...ids];
}

/**
 * Run-level observability correlation (the planner spans every board, so no screen/iteration).
 * Empty fields are omitted, not set to `undefined`, to satisfy `exactOptionalPropertyTypes`.
 */
export function runCorrelation(state: EngineState): RequestCorrelation {
  return {
    ...(state.runId !== undefined ? { runId: state.runId } : {}),
    ...(state.input.brief.restaurant !== undefined
      ? { restaurant: state.input.brief.restaurant }
      : {}),
  };
}

/** Board-level correlation for the per-screen QA-loop calls (paint/critique/repair). */
export function boardCorrelation(state: EngineState, screenId: string): RequestCorrelation {
  return { ...runCorrelation(state), screenId, iteration: state.iteration };
}
