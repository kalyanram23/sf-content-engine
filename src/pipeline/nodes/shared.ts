import type { LayoutsConfig } from "../../config/layouts";
import type {
  CanonicalItem,
  LayoutBlueprint,
  PlanScreen,
  ResolvedTheme,
  ThinPlan,
} from "../../domain/types";
import { mergeBlueprints, selectBlueprint } from "../../planning/layout-strategy";
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
