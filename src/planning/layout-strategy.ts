import type { CanonicalItem, LayoutBlueprint, PlanScreen, PlanSection } from "../domain/types";

/**
 * Per-board layout strategy (pure core). Lives here — not in the painter adapter — because
 * TWO consumers need the same text: the painter renders it as its layout rails, and the
 * vision critic receives it so the screen is graded against the strategy it was actually
 * asked to follow (not a generic notion of "designed").
 *
 * The named-blueprint catalog (config `layouts.blueprints`, D17) supersedes the original
 * two-way branch; the legacy prose below is kept verbatim as the catalog's two seed
 * blueprints (regression-pinned by tests) and as the fallback when no blueprint matches.
 */

export const MATRIX_FIRST_STRATEGY =
  "LAYOUT STRATEGY for this board: MATRIX/TABLE FIRST. Render the price table from the section " +
  "layoutHint as the PRIMARY layout (shared base dish down the rows, the named categories across the " +
  "columns, one price cell per intersection). Use ONE shared compact rotating hero for the whole board " +
  "— do NOT give each section its own hero (a dense table at this canvas has no room for one). A per-item " +
  "photo grid is only a fallback for a non-matrix section that has spare room.";

export const PHOTO_LED_GRID_STRATEGY =
  "LAYOUT STRATEGY for this board: PHOTO-LED GRID. Give EVERY item its own large card filling the grid " +
  "edge to edge, and lead each photo section with its own rotating hero (built as the CAROUSEL above). If a " +
  "section has only 1–3 items, make one item a prominent hero instead of a grid.";

/**
 * True when a board is a price matrix/table (by section representation OR layoutHint). A per-item
 * photo grid fights with a table, so the photo-grid guidance is suppressed for these boards. Takes
 * `Pick<PlanScreen, "sections">` so plan-time code (coverage) can share the exact same check.
 */
export function isMatrixBoard(board: { sections: readonly PlanSection[] }): boolean {
  return board.sections.some(
    (s) => s.representation === "matrix" || /matrix|table/i.test(s.layoutHint ?? ""),
  );
}

/** The legacy two-way strategy — the no-blueprint fallback, kept verbatim for parity. */
export function describeLayoutStrategy(planScreen: PlanScreen): string {
  return isMatrixBoard(planScreen) ? MATRIX_FIRST_STRATEGY : PHOTO_LED_GRID_STRATEGY;
}

/** True when `blueprint.appliesWhen` holds for this board (see the schema for field semantics). */
function blueprintApplies(
  blueprint: LayoutBlueprint,
  planScreen: PlanScreen,
  items: readonly CanonicalItem[],
): boolean {
  const when = blueprint.appliesWhen;

  // Section test: representationAnyOf OR layoutHintPattern (mirrors legacy matrix detection).
  if (when.representationAnyOf !== undefined || when.layoutHintPattern !== undefined) {
    const pattern =
      when.layoutHintPattern !== undefined ? new RegExp(when.layoutHintPattern, "i") : undefined;
    const anySection = planScreen.sections.some(
      (s) =>
        (when.representationAnyOf?.includes(s.representation) ?? false) ||
        (pattern !== undefined && pattern.test(s.layoutHint ?? "")),
    );
    if (!anySection) return false;
  }

  const itemCount = planScreen.sections.reduce((n, s) => n + s.items.length, 0);
  if (when.minItems !== undefined && itemCount < when.minItems) return false;
  if (when.maxItems !== undefined && itemCount > when.maxItems) return false;

  const sectionCount = planScreen.sections.length;
  if (when.minSections !== undefined && sectionCount < when.minSections) return false;
  if (when.maxSections !== undefined && sectionCount > when.maxSections) return false;

  if (when.minPhotoItems !== undefined) {
    const planned = new Set(planScreen.sections.flatMap((s) => s.items));
    const photoItems = items.filter((i) => planned.has(i.id) && (i.images?.length ?? 0) > 0).length;
    if (photoItems < when.minPhotoItems) return false;
  }
  return true;
}

/** Merge per-theme blueprints OVER the engine catalog by id (replace or add). */
export function mergeBlueprints(
  base: readonly LayoutBlueprint[],
  overrides?: readonly LayoutBlueprint[],
): LayoutBlueprint[] {
  if (overrides === undefined || overrides.length === 0) return [...base];
  const byId = new Map(base.map((b) => [b.id, b]));
  for (const override of overrides) byId.set(override.id, override);
  return [...byId.values()];
}

/**
 * Pick the highest-priority blueprint whose `appliesWhen` holds. Deterministic: priority
 * desc, id asc as the tiebreak. Falls back to a legacy-strategy blueprint when nothing
 * matches (e.g. a config removed the catch-all), so selection can never come up empty.
 */
export function selectBlueprint(
  planScreen: PlanScreen,
  items: readonly CanonicalItem[],
  blueprints: readonly LayoutBlueprint[],
): LayoutBlueprint {
  const ordered = [...blueprints].sort(
    (a, b) => b.priority - a.priority || a.id.localeCompare(b.id),
  );
  const match = ordered.find((b) => blueprintApplies(b, planScreen, items));
  return (
    match ?? {
      id: "legacy-fallback",
      priority: -1,
      appliesWhen: {},
      strategy: describeLayoutStrategy(planScreen),
      fixed: [],
      free: [],
    }
  );
}

/** Render a blueprint as the painter-facing strategy block (strategy + FIXED/FREE lists). */
export function renderBlueprintStrategy(blueprint: LayoutBlueprint): string {
  const parts = [blueprint.strategy];
  if (blueprint.fixed.length > 0) {
    parts.push(`FIXED (do not change):\n${blueprint.fixed.map((f) => `- ${f}`).join("\n")}`);
  }
  if (blueprint.free.length > 0) {
    parts.push(`FREE (your call):\n${blueprint.free.map((f) => `- ${f}`).join("\n")}`);
  }
  return parts.join("\n");
}
