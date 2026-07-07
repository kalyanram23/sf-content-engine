/**
 * Plan-time fit arithmetic (pure core). Given the target canvas and a board's row/item count, pick a
 * type-scale directive from a fixed ladder. Three consumers use the SAME computation: the painter
 * (as an explicit "use exactly these sizes" instruction), the vision critic (same text), and the
 * density evaluator (the `overBudget` flag relaxes the over-fill grading, D26) — so the planner,
 * the renderer and the judge agree on what a board holds.
 *
 * Categories are atomic (D25): a board carrying more rows than the comfortable budget is a fact the
 * paint loop cannot change, so instead of a "split this board" signal the directive enters an
 * OVER-BUDGET regime — a two-column name+price layout with per-row height math over ceil(rows/2),
 * stepping type down only to the engine floors (names ≥ text-lg preferred, absolute floor
 * text-base per the painter contract).
 *
 * The ladder rungs (names/prices Tailwind size classes) are tuned so a landscape 1920×1080 canvas
 * yields the reference thresholds ≈ 7 / 13 / 18 rows; a taller portrait canvas fits proportionally
 * more. Row heights are estimates — the QA overflow check is the hard backstop. The usable body also
 * reserves the mandatory MASTHEAD band (see {@link MASTHEAD_FRACTION}), so the budget the painter is
 * handed already excludes it and the last row can't slide off the bottom edge.
 */

import type { DensityTier } from "../domain/types";

export interface Canvas {
  width: number;
  height: number;
}

export interface TypeScale {
  /** Tailwind size class for item names. */
  names: string;
  /** Tailwind size class for prices (one step up from names). */
  prices: string;
}

export interface TypeScaleDirective {
  rows: number;
  /** False only when even the two-column over-budget regime at the floor sizes can't hold it. */
  fits: boolean;
  /** The most rows this canvas holds in ONE comfortable column at the smallest ladder rung. */
  maxRows: number;
  /** How many columns the name+price rows should flow in (2 in the over-budget regime). */
  columns: 1 | 2;
  /** True when rows exceed the comfortable single-column budget → the two-column dense regime (D26). */
  overBudget: boolean;
  /** The chosen ladder rung (the floor rung when `!fits`). */
  scale: TypeScale;
  /** Painter-facing instruction rendered into the prompt (and shown to the critic). */
  text: string;
}

/** Vertical chrome (top/bottom margins + generic frame) unavailable for rows, in px. The mandatory
 * MASTHEAD band is reserved SEPARATELY on top of this ({@link MASTHEAD_FRACTION}) — this constant
 * predates the masthead and is left as-is so the non-masthead margins keep their original slack. */
const DEFAULT_CHROME_PX = 200;

/**
 * Fraction of canvas HEIGHT reserved for the mandatory MASTHEAD band, on top of {@link
 * DEFAULT_CHROME_PX}. Every plan screen now carries a computed title rendered as one slim masthead
 * band at the very top of every board (the painter's MASTHEAD contract). That band was NOT part of
 * the original chrome allowance, so the row/type arithmetic used to hand the painter ~6% too much
 * vertical budget and the last row slid off the bottom edge (the masthead overflow regression).
 *
 * We reserve 6% — the slim end of the contract's "≤ roughly 6%" cap, kept at parity with it so the
 * budget we reserve and the band the painter actually draws agree (reserve ≥ draw → no overflow).
 * Applied to BOTH orientations (as a fraction of height it scales with the canvas: ~65px on a 1080px
 * landscape, ~115px on a 1920px portrait). Deliberately NOT a raw px constant — a slim band's height
 * tracks the canvas, and a proportional reserve keeps landscape and portrait consistent.
 */
const MASTHEAD_FRACTION = 0.06;

/** Vertical space (px) the mandatory masthead band consumes on this canvas — see {@link MASTHEAD_FRACTION}. */
function mastheadAllowancePx(canvas: Canvas): number {
  return Math.round(canvas.height * MASTHEAD_FRACTION);
}

/**
 * The comfortable single-column budget when no planning config is threaded — mirrors
 * `planning.legibilityBudget` (24). Beyond it the over-budget two-column regime applies.
 */
const DEFAULT_COMFORT_BUDGET = 24;

/**
 * The comfortable ladder, largest rung first. `rowPx` is the estimated height of one row at that
 * size; it is tuned so a ~815px landscape body (1080 − 200 chrome − 65 masthead) yields ≈ 7 / 13 / 18
 * rows.
 */
const LADDER: Array<TypeScale & { rowPx: number }> = [
  { names: "text-3xl", prices: "text-4xl", rowPx: 110 },
  { names: "text-2xl", prices: "text-3xl", rowPx: 62 },
  { names: "text-xl", prices: "text-2xl", rowPx: 44 },
];

/**
 * The OVER-BUDGET ladder (two-column regime, D26), largest rung first. Bottoms out at the engine
 * floors from the painter contract: names ≥ text-lg preferred, absolute floor text-base.
 */
const OVER_BUDGET_LADDER: Array<TypeScale & { rowPx: number }> = [
  { names: "text-xl", prices: "text-2xl", rowPx: 44 },
  { names: "text-lg", prices: "text-xl", rowPx: 38 },
  { names: "text-base", prices: "text-lg", rowPx: 32 },
];

/** The body height (px) available for rows after reserving chrome AND the mandatory masthead band. */
function bodyHeight(canvas: Canvas, chromePx: number): number {
  return Math.max(1, canvas.height - chromePx - mastheadAllowancePx(canvas));
}

/** How many rows fit at a given rung on this canvas. */
function rowsAt(canvas: Canvas, rowPx: number, chromePx: number): number {
  return Math.max(1, Math.floor(bodyHeight(canvas, chromePx) / rowPx));
}

/** The most rows this canvas holds in one column at the SMALLEST comfortable rung. */
export function maxRowsForCanvas(canvas: Canvas, chromePx: number = DEFAULT_CHROME_PX): number {
  const smallest = LADDER[LADDER.length - 1]!;
  return rowsAt(canvas, smallest.rowPx, chromePx);
}

/**
 * The comfortable ladder rung that best fits `rowCount` rows on this canvas: the LARGEST rung whose
 * per-canvas capacity still holds them (walking largest→smallest), falling back to the smallest rung
 * when even that can't. Fewer rows → a larger rung. Used for both the single-column rung and the
 * two-column rung (over `ceil(rows/2)` rows) so the directive can quote the exact bigger size a
 * two-column layout must step up to.
 */
function pickComfortableRung(canvas: Canvas, rowCount: number, chromePx: number): TypeScale {
  for (const rung of LADDER) {
    if (rowCount <= rowsAt(canvas, rung.rowPx, chromePx)) {
      return { names: rung.names, prices: rung.prices };
    }
  }
  const smallest = LADDER[LADDER.length - 1]!;
  return { names: smallest.names, prices: smallest.prices };
}

/**
 * The comfortable single-column ROW BUDGET for a canvas: the config `legibilityBudget`, tightened
 * to what the canvas can physically hold at the smallest comfortable rung. The single source of
 * this arithmetic — `computeTypeScale` (the over-budget threshold) AND the density-tier
 * classifier (D30) both use it, so plan-time stamping and QA-time recomputation never disagree.
 */
export function comfortableRowBudget(
  canvas: Canvas,
  comfortableBudget: number = DEFAULT_COMFORT_BUDGET,
  chromePx: number = DEFAULT_CHROME_PX,
): number {
  return Math.max(1, Math.min(comfortableBudget, maxRowsForCanvas(canvas, chromePx)));
}

/** Default multiplier splitting the two over-budget density tiers (mirrors `planning.packedMultiplier`). */
export const DEFAULT_PACKED_MULTIPLIER = 2;

/**
 * The deterministic density tier (D30) for a board carrying `rows` rows against `budget` (the
 * comfortable per-canvas row budget from {@link comfortableRowBudget}): `comfortable` at/under
 * budget, `dense` up to `packedMultiplier`×budget, `packed` beyond. Pure arithmetic — the same
 * function stamps the plan (`expandLayoutToPlan`) and recomputes the tier for a hand-authored plan
 * at paint/critique time, so all consumers agree on what a board is.
 */
export function densityTier(
  rows: number,
  budget: number,
  packedMultiplier: number = DEFAULT_PACKED_MULTIPLIER,
): DensityTier {
  if (rows <= budget) return "comfortable";
  if (rows <= budget * packedMultiplier) return "dense";
  return "packed";
}

/**
 * Compute the type-scale directive for `rows` rows on `canvas`. Within the comfortable budget
 * (`comfortableBudget`, i.e. `planning.legibilityBudget`, tightened to what the canvas physically
 * holds) it walks the single-column ladder largest→smallest. Beyond it — an over-budget board the
 * plan chose to keep atomic (D25/D26) — it prescribes a TWO-COLUMN layout over `ceil(rows/2)` rows
 * per column, stepping down to the engine floors and never below; `fits:false` only when even that
 * can't hold the rows (the painter is still told to render everything, as compactly as possible).
 */
export function computeTypeScale(
  rows: number,
  canvas: Canvas,
  chromePx: number = DEFAULT_CHROME_PX,
  comfortableBudget: number = DEFAULT_COMFORT_BUDGET,
): TypeScaleDirective {
  const maxRows = maxRowsForCanvas(canvas, chromePx);
  const budget = comfortableRowBudget(canvas, comfortableBudget, chromePx);
  const body = bodyHeight(canvas, chromePx);

  if (rows <= budget) {
    // Single-column rung (the returned `scale`, kept for backward-compatible callers) AND the
    // TWO-column rung it must step UP to when the painter legitimately flows the rows in two columns
    // (~ceil(rows/2) per column covers only half the height at the single-column size). The directive
    // hands the painter the fill arithmetic for BOTH layouts so it can't silently break the
    // single-column prescription by choosing two columns and leaving the bottom half empty.
    const perColumn = Math.ceil(rows / 2);
    const rung1 = pickComfortableRung(canvas, rows, chromePx);
    const rung2 = pickComfortableRung(canvas, perColumn, chromePx);
    return {
      rows,
      fits: true,
      maxRows,
      columns: 1,
      overBudget: false,
      scale: rung1,
      text:
        `TYPE SCALE: ~${body}px of body height must be SPANNED by your content — this figure ALREADY ` +
        `reserves the slim masthead band at the top, so do NOT subtract extra height for it. This board has ` +
        `${rows} row(s). Single column → names at ${rung1.names}, prices ${rung1.prices}. If you use ` +
        `TWO columns (~${perColumn} rows/col) the rows only cover half that height — then you MUST go ` +
        `bigger (${rung2.names}/${rung2.prices}, computed from the ladder for ${perColumn} rows) ` +
        `AND/OR give the section image slot / photo hero the reclaimed height (hero up to ~40% of ` +
        `the canvas). Whatever layout you choose, content + image slots must span the full body — a ` +
        `band of empty canvas taller than ~15% of the body is a defect.`,
    };
  }

  // OVER-BUDGET regime (D26): the plan kept an oversized category atomic on this board. Direct a
  // two-column name+price layout so the density is a deliberate composition, not a shrink-to-fit.
  const perColumn = Math.ceil(rows / 2);
  for (const rung of OVER_BUDGET_LADDER) {
    const cap = rowsAt(canvas, rung.rowPx, chromePx);
    if (perColumn <= cap) {
      return {
        rows,
        fits: true,
        maxRows,
        columns: 2,
        overBudget: true,
        scale: { names: rung.names, prices: rung.prices },
        text:
          `TYPE SCALE (over-budget board): this board carries ${rows} name+price rows — beyond ` +
          `the comfortable ~${budget}-row single-column budget for this canvas. Lay the rows out ` +
          `in TWO balanced narrow columns (~${perColumn} rows per column in ~${body}px of body ` +
          `height — this figure already excludes the slim masthead band, so reserve no extra for it), ` +
          `item names at ${rung.names} and prices at ${rung.prices} (headers larger ` +
          `still). These sizes are the floor — never shrink below them (engine absolute floor ` +
          `text-base) and never overflow the canvas; the board is expected to read dense.`,
      };
    }
  }

  const floor = OVER_BUDGET_LADDER[OVER_BUDGET_LADDER.length - 1]!;
  const floorCap = rowsAt(canvas, floor.rowPx, chromePx);
  return {
    rows,
    fits: false,
    maxRows,
    columns: 2,
    overBudget: true,
    scale: { names: floor.names, prices: floor.prices },
    text:
      `TYPE SCALE (over-budget board): ${rows} name+price rows exceed even a two-column layout ` +
      `at the minimum sizes on this canvas (~${floorCap * 2} max, after the slim masthead band is ` +
      `reserved). Render EVERY item anyway: two ` +
      `balanced narrow columns, item names at ${floor.names} (the engine's absolute floor) and ` +
      `prices at ${floor.prices}, trim all non-essential chrome and margins, and DO NOT overflow ` +
      `the canvas. Expect a very dense board.`,
  };
}
