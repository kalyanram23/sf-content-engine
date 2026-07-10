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
 * text-base per the painter contract). Classification is COLUMN-AWARE (D70): the over-budget regime
 * only applies when the rows exceed even TWO comfortable columns; a board over the raw budget whose
 * rows-per-column fit it is an effectively-comfortable two-column board and gets concrete sparse
 * fill targets instead (see {@link effectiveRowLoad}).
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
  /** How many columns the name+price rows should flow in (2 in the effectively-comfortable
   * two-column band AND the over-budget regime — column-aware selection, D70). */
  columns: 1 | 2;
  /** True only when rows exceed even TWO comfortable columns (rows-per-column over the budget) →
   * the genuinely over-budget dense regime (D26, column-aware since D70). */
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
 * Root font size (px) Tailwind's rem units resolve against — the sparse targets (D70) are quoted in
 * rem so the painter can obey them with rem-based token utilities (`h-16`, `py-*`, `text-*`) rather
 * than the forbidden raw px/hex.
 */
const ROOT_FONT_PX = 16;

/**
 * Estimated vertical budget (rem) each planned SECTION consumes before its rows — the header (title +
 * rule) and its own top spacing. Subtracted per planned section so the sparse row-height target
 * reflects the real space left for item rows (D70). A coarse estimate; the QA overflow/dead-band
 * checks are the hard backstop.
 */
const SECTION_HEADER_REM = 3;

/** Target vertical gap (rem) between consecutive sections — the sparse directive's `section spacing`. */
const SECTION_SPACING_REM = 2;

/**
 * Fraction of a row's vertical PITCH that is the glyph height (the rest is leading + padding). Turns
 * a computed row height into an item-name/price TYPE target. Clamped to {@link MIN_TYPE_REM}/{@link
 * MAX_TYPE_REM} so a very sparse board is not told to set absurd 6rem body text that can't wrap.
 */
const TYPE_TO_ROW_RATIO = 0.45;
const MIN_TYPE_REM = 1.25; // ~text-xl — never below the engine's preferred floor
const MAX_TYPE_REM = 3; // ~text-5xl — a ceiling so huge rows become padding/photo, not giant text

/** Round a rem figure to a sane step (0.25rem is exact in binary, so no float noise) for the prompt. */
function roundRem(rem: number, step: number): number {
  return Math.round(rem / step) * step;
}

/** Format a rem figure for the prompt: `4` → "4rem", `1.75` → "1.75rem" (no trailing `.0`). */
function remLabel(rem: number): string {
  return `${rem}rem`;
}

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
 * The column layout the sizing ladder prescribes for `rows` against the comfortable per-canvas
 * `budget`, and the EFFECTIVE per-column row load that layout yields (D70): ONE column at/under the
 * budget; TWO columns beyond it (the ladder's own over-budget prescription, D26). The painter's
 * actual layout is per-column, so `rowsPerColumn` — not the raw row count — is what density
 * judgements must classify against: a 36-row board the ladder renders as 2×18 is effectively an
 * 18-row board (live-validated: classifying it dense prescribed floor-pitch columns covering only
 * ~half the body → ~26–31% fill). This is the ONE shared notion of effective load —
 * `computeTypeScale` (branch selection) and {@link densityTier} (tier classification) both derive
 * from it, so the sizing targets, the painter register, the critic's brief and QA's plan-forced
 * allowance can never disagree about what a board is.
 */
export function effectiveRowLoad(
  rows: number,
  budget: number,
): { columns: 1 | 2; rowsPerColumn: number } {
  const columns: 1 | 2 = rows <= budget ? 1 : 2;
  return { columns, rowsPerColumn: Math.max(1, Math.ceil(rows / columns)) };
}

/**
 * The deterministic density tier (D30; column-aware since D70) for a board carrying `rows` rows
 * against `budget` (the comfortable per-canvas row budget from {@link comfortableRowBudget}):
 * `comfortable` while the rows fit the budget PER COLUMN at the ladder's own column choice
 * ({@link effectiveRowLoad}), `dense` beyond that up to `packedMultiplier`×budget, `packed` beyond.
 * With the default multiplier (2) the dense band is empty — two comfortable columns hold exactly
 * 2×budget — so default-config boards classify comfortable or packed; the dense register remains
 * reachable via a larger multiplier or a plan-stamped tier. Pure arithmetic — the same function
 * stamps the plan (`expandLayoutToPlan`) and recomputes the tier for a hand-authored plan at
 * paint/critique time, so all consumers agree on what a board is.
 */
export function densityTier(
  rows: number,
  budget: number,
  packedMultiplier: number = DEFAULT_PACKED_MULTIPLIER,
): DensityTier {
  if (effectiveRowLoad(rows, budget).rowsPerColumn <= budget) return "comfortable";
  if (rows <= budget * packedMultiplier) return "dense";
  return "packed";
}

/** Concrete, computed fill targets (rem) for a sparse (comfortable-tier) board — see {@link sparseFillTargets}. */
export interface SparseFillTargets {
  /** Effective rows in one column at this column count (a 2-col layout halves the effective rows). */
  rowsPerColumn: number;
  /** Vertical space (rem) each row should occupy so the rows SPAN the usable body top-to-bottom. */
  rowHeightRem: number;
  /** Target item-name/price glyph size (rem), derived from the row pitch and clamped to a sane range. */
  typeRem: number;
  /** Height (rem) a category photo panel may legitimately claim (a real anchor, not a thin sliver). */
  photoBandRem: number;
  /** Target gap (rem) between consecutive sections. */
  sectionSpacingRem: number;
}

/**
 * Concrete rem fill targets for a SPARSE (comfortable-tier) board (D70). Relative "scale up on a
 * sparse board" prose repeatedly failed to move the painter off the exemplar's dense floor-scale
 * sizes; LLMs comply with numeric targets, not vibes. This distributes the USABLE body height —
 * canvas minus the frame inset ({@link DEFAULT_CHROME_PX}), the masthead band ({@link
 * MASTHEAD_FRACTION}), and the per-section header overhead ({@link SECTION_HEADER_REM} × the planned
 * section count) — across the rows PER COLUMN, yielding an obeyable target row height. A 2-column
 * layout halves the effective rows (`ceil(rows/columns)`) and so earns a BIGGER per-row target, which
 * is how the directive "respects the blueprint's column structure". Pure arithmetic; the same
 * computation feeds the painter and the vision critic through the sizing-directive text.
 */
export function sparseFillTargets(
  rows: number,
  canvas: Canvas,
  sections: number,
  columns: 1 | 2,
  chromePx: number = DEFAULT_CHROME_PX,
): SparseFillTargets {
  const bodyRem = bodyHeight(canvas, chromePx) / ROOT_FONT_PX;
  const sectionCount = Math.max(1, Math.round(sections));
  const overheadRem =
    sectionCount * SECTION_HEADER_REM + Math.max(0, sectionCount - 1) * SECTION_SPACING_REM;
  const usableRem = Math.max(4, bodyRem - overheadRem);
  const rowsPerColumn = Math.max(1, Math.ceil(rows / columns));
  const rowPitchRem = usableRem / rowsPerColumn;
  const rowHeightRem = Math.max(2, roundRem(rowPitchRem, 0.25));
  const typeRem = Math.min(
    MAX_TYPE_REM,
    Math.max(MIN_TYPE_REM, roundRem(rowPitchRem * TYPE_TO_ROW_RATIO, 0.25)),
  );
  // A category photo panel is a legitimate way to consume height on a sparse board (worth ≈ 3 rows),
  // capped at ~40% of the usable body so it stays a section anchor, never the whole board.
  const photoBandRem = Math.min(
    roundRem(usableRem * 0.4, 1),
    Math.max(6, roundRem(rowPitchRem * 3, 1)),
  );
  return {
    rowsPerColumn,
    rowHeightRem,
    typeRem,
    photoBandRem,
    sectionSpacingRem: SECTION_SPACING_REM,
  };
}

/**
 * The SPARSE size directive appended to the comfortable-branch type-scale text (D70): concrete rem
 * targets the painter can obey mechanically instead of a relative nudge. For a board within the
 * single-column budget (`columns` 1) it quotes targets for BOTH the single- and two-column layouts
 * the painter might choose. For a board the ladder itself lays out in two columns (`columns` 2 — the
 * effectively-comfortable middle band, raw rows over budget but rows-per-column within it) it quotes
 * the TWO-column targets only: offering a "single column" option there would prescribe a layout the
 * rows can't comfortably fit. The rows filling the usable body top-to-bottom is the fill invariant;
 * a photo panel legitimately consumes some of that height (it is not additional budget). Kept
 * theme-agnostic — sizes only, tokens stay the theme's.
 */
function renderSparseSizeDirective(
  rows: number,
  canvas: Canvas,
  sections: number,
  chromePx: number,
  columns: 1 | 2,
): string {
  const single = sparseFillTargets(rows, canvas, sections, 1, chromePx);
  const dual = sparseFillTargets(rows, canvas, sections, 2, chromePx);
  const chosen = columns === 2 ? dual : single;
  const sectionCount = Math.max(1, Math.round(sections));
  const header =
    columns === 2
      ? `SIZE DIRECTIVE (sparse two-column board, ${rows} rows across ${sectionCount} sections → ` +
        `~${dual.rowsPerColumn} rows per column — `
      : `SIZE DIRECTIVE (sparse board, ${rows} rows across ${sectionCount} sections — `;
  const layoutTargets =
    columns === 2
      ? `TWO columns is the prescribed layout: target row height ≈ ${remLabel(dual.rowHeightRem)} ` +
        `per row (item name/price type ≈ ${remLabel(dual.typeRem)}) — at the exemplar's dense row ` +
        `pitch, two columns of ${dual.rowsPerColumn} rows cover only about HALF the body, which ` +
        `fails the under-fill floor. `
      : `Single column (${single.rowsPerColumn} rows): target row height ≈ ${remLabel(single.rowHeightRem)} ` +
        `(item name/price type ≈ ${remLabel(single.typeRem)}). ` +
        `Two columns (~${dual.rowsPerColumn} rows/col): target row height ≈ ${remLabel(dual.rowHeightRem)} ` +
        `(type ≈ ${remLabel(dual.typeRem)}). `;
  return (
    header +
    `these are COMPUTED targets to OBEY; the exemplar's dense rem sizes are a FLOOR you scale UP from, ` +
    `never a template). Fill the usable body top-to-bottom so content reaches within ~2rem of the ` +
    `bottom frame — a band of dead cream taller than ~15% of the body fails QA. ` +
    layoutTargets +
    `A category photo panel may claim ≈ ${remLabel(chosen.photoBandRem)} of height — a real anchor, ` +
    `never a thin sliver; it consumes fill, it is not extra budget. Section spacing ≈ ${remLabel(chosen.sectionSpacingRem)}.`
  );
}

/**
 * Compute the type-scale directive for `rows` rows on `canvas`. Branch selection is COLUMN-AWARE
 * (D70) via {@link effectiveRowLoad} — the classification quantity is rows PER COLUMN at the
 * ladder's own column choice, not the raw row count:
 *
 *  1. rows ≤ budget (`comfortableBudget`, i.e. `planning.legibilityBudget`, tightened to what the
 *     canvas physically holds): the single-column comfortable branch — walks the ladder
 *     largest→smallest and appends the concrete sparse SIZE DIRECTIVE for both layout options.
 *  2. rows > budget but rows-per-column ≤ budget at two columns: the effectively-comfortable
 *     TWO-COLUMN branch — the comfortable rung for the per-column load plus the concrete
 *     two-column targets (live-validated: grading this band dense prescribed floor-pitch columns
 *     covering ~half the body → ~26–31% fill on a 36-row 9:16 board).
 *  3. Beyond even two comfortable columns — a genuinely over-budget board the plan kept atomic
 *     (D25/D26) — the dense regime: TWO columns over `ceil(rows/2)`, stepping down to the engine
 *     floors and never below; `fits:false` only when even that can't hold the rows (the painter is
 *     still told to render everything, as compactly as possible). This branch's text is
 *     byte-unchanged by D70.
 *
 * `sections` (the planned section count) feeds ONLY the comfortable branches' appended SIZE
 * DIRECTIVE (D70) — the concrete rem row-height targets subtract per-section header overhead. The
 * over-budget branch ignores it, so the dense-path text is byte-identical regardless of the argument.
 */
export function computeTypeScale(
  rows: number,
  canvas: Canvas,
  chromePx: number = DEFAULT_CHROME_PX,
  comfortableBudget: number = DEFAULT_COMFORT_BUDGET,
  sections: number = 1,
): TypeScaleDirective {
  const maxRows = maxRowsForCanvas(canvas, chromePx);
  const budget = comfortableRowBudget(canvas, comfortableBudget, chromePx);
  const body = bodyHeight(canvas, chromePx);
  const load = effectiveRowLoad(rows, budget);

  if (load.columns === 1) {
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
      // The legacy ladder-rung prose (Tailwind classes + relative "go bigger") is kept verbatim as
      // the prefix, then the D70 SIZE DIRECTIVE appends COMPUTED rem targets: prose alone never moved
      // the painter off the exemplar's dense floor sizes on a sparse board — it complies with numbers.
      text:
        `TYPE SCALE: ~${body}px of body height must be SPANNED by your content — this figure ALREADY ` +
        `reserves the slim masthead band at the top, so do NOT subtract extra height for it. This board has ` +
        `${rows} row(s). Single column → names at ${rung1.names}, prices ${rung1.prices}. If you use ` +
        `TWO columns (~${perColumn} rows/col) the rows only cover half that height — then you MUST go ` +
        `bigger (${rung2.names}/${rung2.prices}, computed from the ladder for ${perColumn} rows) ` +
        `AND/OR give the section image slot / photo hero the reclaimed height (hero up to ~40% of ` +
        `the canvas). Whatever layout you choose, content + image slots must span the full body — a ` +
        `band of empty canvas taller than ~15% of the body is a defect.\n\n` +
        renderSparseSizeDirective(rows, canvas, sections, chromePx, 1),
    };
  }

  if (load.rowsPerColumn <= budget) {
    // COMFORTABLE AT TWO COLUMNS (D70): raw rows exceed the single-column budget, but the two
    // columns the ladder prescribes hold them at COMFORTABLE per-column loads — so this is an
    // effectively-sparse board, not a dense one. It gets the comfortable rung for its per-column
    // load plus the concrete two-column fill targets; grading it dense (the pre-D70 behaviour)
    // handed it the floor-size directive and it measurably under-filled (~26–31% vs the 40% floor).
    const perColumn = load.rowsPerColumn;
    const rung = pickComfortableRung(canvas, perColumn, chromePx);
    return {
      rows,
      fits: true,
      maxRows,
      columns: 2,
      overBudget: false,
      scale: rung,
      text:
        `TYPE SCALE (two-column comfortable board): this board carries ${rows} name+price rows — ` +
        `beyond the ~${budget}-row single-column budget, but TWO balanced columns (~${perColumn} ` +
        `rows per column) hold them at COMFORTABLE sizes in ~${body}px of body height (this figure ` +
        `ALREADY reserves the slim masthead band at the top, so do NOT subtract extra height for ` +
        `it). Names at ${rung.names}, prices ${rung.prices}, headers larger still. This is NOT a ` +
        `floor-size dense board: the rows must SPAN the full body per the SIZE DIRECTIVE below — a ` +
        `band of empty canvas taller than ~15% of the body is a defect.\n\n` +
        renderSparseSizeDirective(rows, canvas, sections, chromePx, 2),
    };
  }

  // OVER-BUDGET regime (D26): the plan kept an oversized category atomic on this board — its rows
  // exceed even TWO comfortable columns (column-aware selection, D70). Direct a two-column
  // name+price layout so the density is a deliberate composition, not a shrink-to-fit.
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
