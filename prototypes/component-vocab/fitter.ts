/**
 * The fitter — pure sizing/column/layout logic, now ASPECT-AWARE.
 *
 * Given the resolved body blocks + the canvas, it (1) derives a LAYOUT PLAN from the canvas aspect,
 * (2) chooses ONE size register (L/M/S) for the whole board and (3) — for non-portrait boards —
 * distributes the blocks across newspaper columns, so the content plausibly SPANS the canvas.
 *
 * Two layout modes:
 *   - "stack"   (portrait, h > w): the original behaviour — full-width component stripes stacked
 *     top-to-bottom; a section may run 1–2 internal price-list columns; `justify-content:space-between`
 *     turns a modest under-fill into airy gaps (like the gold board).
 *   - "columns" (landscape, w ≥ h): the body is a BALANCED MULTI-COLUMN ROW FLOW. Sections render
 *     single-stream (one price row per line) and flow down column 1, spilling into column 2, etc; a
 *     long section SPLITS across a column boundary at a ROW boundary (its header is glued to its first
 *     row so it never orphans). The renderer draws this with CSS `column-count`/`column-fill:balance`,
 *     so column heights even out at row granularity — no whole-section lumps, no half-empty column.
 *     triBands are expanded upstream into individual sections; one photo collage, if present, is a
 *     full-width filmstrip banner above the columns (see render.ts). Because balancing is now at row
 *     granularity, the fitter re-derives the register UPWARD: it picks the LARGEST register whose
 *     balanced flow (≈ total flow height / column count) still fits the body height under the banner.
 *
 * The three registers are anchored on the gold board's own numbers (M ≈ gold), scaled up (L) for a
 * sparse board and down (S) for a dense one.
 */

import type { Block, Canvas, Register, ResolvedSection } from "./catalog";

// Canvas geometry of the de-runtimed shell (px), measured from the gold board:
//   1080×1920 − 16px stripe frame each side → 1048×1888 paper.
//   header 96px; content column padding 24px top / 30px bottom, 36px sides.
const FRAME = 16;
const HEADER = 96;
const PAD_TOP = 24;
const PAD_BOTTOM = 30;
const PAD_SIDE = 36;
const COL_GAP = 44; // gutter between newspaper columns (columns mode) == CSS column-gap
export const BANNER_GAP = 24; // space under a full-width filmstrip banner (columns mode)

// ── balanced-flow (landscape "columns") tuning ─────────────────────────────────────────────────────
// A landscape column narrower than this would wrap the longest dish names onto a second line (which
// wrecks the row-height estimate), so we never subdivide the body below it.
const MIN_STREAM_WIDTH = 430;
// Vertical rhythm between two flowing sections (margin-bottom on each section in the flow).
export const SECTION_GAP = 14;
// Full-width filmstrip banner height in landscape (fixed, register-independent, so the register search
// isn't chasing its own tail). Comfortable enough to read the food photos; small enough to leave the
// body room for a LARGE type register — the whole point of the row-flow rewrite.
export const LANDSCAPE_BANNER_H = 224;
// Pick the largest register whose balanced column height ≤ this fraction of the body under the banner.
const COLUMNS_FILL = 0.95;

export function contentBox(canvas: Canvas): { width: number; height: number } {
  return {
    width: canvas.width - 2 * FRAME - 2 * PAD_SIDE,
    height: canvas.height - 2 * FRAME - HEADER - PAD_TOP - PAD_BOTTOM,
  };
}

export type LayoutMode = "stack" | "columns";

/** Canvas-derived plan (pre-fit): mode + the search space for the newspaper-column count. */
export interface LayoutPlan {
  mode: LayoutMode;
  bodyWidth: number;
  bodyHeight: number;
  gap: number;
  minColumns: number; // columns mode: start of the escalation search
  maxColumns: number; // columns mode: cap (keeps each column ≥ MIN_COL_WIDTH)
}

/** Post-fit layout the renderer draws with (the fitter resolves `columns` by escalation). */
export interface ResolvedLayout {
  mode: LayoutMode;
  columns: number; // 1 for stack
  columnWidth: number; // width of a single newspaper column (== bodyWidth for stack)
  maxInternalCols: number; // internal price columns a big section may use (1 or 2)
  gap: number;
  bodyWidth: number;
  bodyHeight: number;
}

function columnWidthFor(bodyWidth: number, columns: number): number {
  return Math.floor((bodyWidth - (columns - 1) * COL_GAP) / columns);
}

/**
 * Derive the layout plan from the canvas aspect.
 *   portrait (h > w)      → stack (1 column, original behaviour)
 *   landscape (w ≥ h)     → balanced multi-column flow; the fitter searches the column count (2 →
 *     maxColumns, capped so each column stays ≥ MIN_STREAM_WIDTH) jointly with the register, biasing
 *     to the LARGEST register (fewest columns for it). A non-portrait square canvas is treated as
 *     landscape — we no longer special-case square.
 */
export function planLayout(canvas: Canvas): LayoutPlan {
  const box = contentBox(canvas);
  const portrait = canvas.height > canvas.width;
  if (portrait) {
    return {
      mode: "stack",
      bodyWidth: box.width,
      bodyHeight: box.height,
      gap: 0,
      minColumns: 1,
      maxColumns: 1,
    };
  }
  // How many MIN_STREAM_WIDTH columns (plus their gutters) fit across the body.
  const maxColumns = Math.max(2, Math.floor((box.width + COL_GAP) / (MIN_STREAM_WIDTH + COL_GAP)));
  return {
    mode: "columns",
    bodyWidth: box.width,
    bodyHeight: box.height,
    gap: COL_GAP,
    minColumns: 2,
    maxColumns,
  };
}

export const REGISTERS: Record<"L" | "M" | "S", Register> = {
  L: {
    name: "L",
    chip: 34,
    chipFont: 15,
    sectionTitle: 38,
    headerMb: 12,
    rowName: 23,
    rowPad: 7,
    colGap: 48,
    smChip: 28,
    smChipFont: 13,
    smSectionTitle: 27,
    smRowName: 20,
    smRowPad: 6,
    smHeaderMb: 10,
    cardW: 344,
    cardPhotoH: 250,
    captionFont: 19,
  },
  M: {
    name: "M",
    chip: 30,
    chipFont: 14,
    sectionTitle: 31,
    headerMb: 8,
    rowName: 19,
    rowPad: 4,
    colGap: 44,
    smChip: 26,
    smChipFont: 13,
    smSectionTitle: 24,
    smRowName: 18,
    smRowPad: 4,
    smHeaderMb: 8,
    cardW: 300,
    cardPhotoH: 220,
    captionFont: 16,
  },
  S: {
    name: "S",
    chip: 26,
    chipFont: 12,
    sectionTitle: 26,
    headerMb: 6,
    rowName: 17,
    rowPad: 3,
    colGap: 36,
    smChip: 22,
    smChipFont: 11,
    smSectionTitle: 21,
    smRowName: 16,
    smRowPad: 3,
    smHeaderMb: 6,
    cardW: 262,
    cardPhotoH: 188,
    captionFont: 14,
  },
};

const LINE = 1.25; // line-height factor for row-height estimates

function rowH(r: Register, small: boolean): number {
  const name = small ? r.smRowName : r.rowName;
  const pad = small ? r.smRowPad : r.rowPad;
  return name * LINE + pad * 2;
}
function headerH(r: Register, small: boolean): number {
  const title = small ? r.smSectionTitle : r.sectionTitle;
  const mb = small ? r.smHeaderMb : r.headerMb;
  return title * 1.15 + mb + 4;
}

/**
 * Internal price columns a section uses: small sections (≤4) stay single; bigger ones use up to
 * `maxInternalCols` (1 in a narrow newspaper column, 2 in a wide one or in the portrait stack).
 * `sectionColumns` is the portrait-stack shorthand (maxInternalCols = 2), kept for back-compat.
 */
export function sectionInternalCols(itemCount: number, maxInternalCols: number): number {
  return itemCount <= 4 ? 1 : maxInternalCols;
}
export function sectionColumns(itemCount: number): number {
  return sectionInternalCols(itemCount, 2);
}

export function collageBandHeight(r: Register): number {
  return r.cardPhotoH + r.captionFont * LINE + 22 + 34; // photo + caption + card padding + tilt slack
}

/** Estimated height (px) a resolved body block consumes at register `r` with `maxInternalCols`. */
function blockHeight(
  block: Block,
  sectionsByTitle: Map<string, ResolvedSection>,
  r: Register,
  maxInternalCols: number,
): number {
  if (block.type === "collage") return collageBandHeight(r);
  if (block.type === "triBand") {
    const secs = (block.sections ?? [])
      .map((t) => sectionsByTitle.get(t))
      .filter((s): s is ResolvedSection => Boolean(s));
    const maxRows = Math.max(1, ...secs.map((s) => s.items.length)); // each mini list is 1 column
    return headerH(r, true) + maxRows * rowH(r, true);
  }
  const sec = block.section ? sectionsByTitle.get(block.section) : undefined;
  const count = sec?.items.length ?? 0;
  const cols = sectionInternalCols(count, maxInternalCols);
  return headerH(r, false) + Math.ceil(count / cols) * rowH(r, false);
}

export interface FitInput {
  blocks: Block[]; // flowing blocks (stack: all; columns: everything except the extracted banner)
  sectionsByTitle: Map<string, ResolvedSection>;
  plan: LayoutPlan;
  banner?: Block | null; // columns mode: a full-width filmstrip band reserved above the columns
}

export interface FitResult {
  register: Register;
  layout: ResolvedLayout;
  contentHeight: number; // bodyHeight (px)
  usedHeight: number; // stack: total block height; columns: est. balanced column height + banner
  fill: number; // usedHeight / bodyHeight
  bannerHeight: number; // 0 in stack mode / when no banner
}

const REGISTER_ORDER: Array<"L" | "M" | "S"> = ["L", "M", "S"];
const registerRank = (name: "L" | "M" | "S"): number => REGISTER_ORDER.length - REGISTER_ORDER.indexOf(name);

/**
 * Pick the layout that fits with the largest type.
 *
 *   stack:   pick the LARGEST register whose total estimated height ≤ 92% of the body (the rest
 *            becomes distributed air).
 *   columns: BALANCED ROW FLOW. Total flow height (single-stream section heights + inter-section
 *            gaps) balanced across N columns is ≈ total/N. Search (columns, register) jointly and
 *            keep the LARGEST register that fits — with the FEWEST columns for that register. More
 *            columns lets a bigger register fit (shorter balanced height), but a column may not be
 *            narrower than MIN_STREAM_WIDTH (long dish names would wrap). Row-granularity balancing
 *            means no whole-section lump forces the type down — the escape from the old forced-small.
 *
 * If nothing fits even at maxColumns/S, return the densest attempt (renderer clips; the screenshot
 * reveals it — an honest broken board, never a silent lie).
 */
export function fit(input: FitInput): FitResult {
  const { blocks, sectionsByTitle, plan, banner } = input;

  if (plan.mode === "stack") {
    const layout: ResolvedLayout = {
      mode: "stack",
      columns: 1,
      columnWidth: plan.bodyWidth,
      maxInternalCols: 2,
      gap: 0,
      bodyWidth: plan.bodyWidth,
      bodyHeight: plan.bodyHeight,
    };
    let last: FitResult | null = null;
    for (const key of REGISTER_ORDER) {
      const r = REGISTERS[key];
      const used = blocks.reduce((s, b) => s + blockHeight(b, sectionsByTitle, r, 2), 0);
      const res: FitResult = {
        register: r,
        layout,
        contentHeight: plan.bodyHeight,
        usedHeight: used,
        fill: used / plan.bodyHeight,
        bannerHeight: 0,
      };
      if (used <= plan.bodyHeight * 0.92) return res;
      last = res;
    }
    return last!;
  }

  // columns mode: balanced multi-column flow. Banner height is fixed (register-independent) so the
  // register search doesn't chase its own tail; sections flow single-stream (1 internal column).
  const bannerH = banner ? LANDSCAPE_BANNER_H + BANNER_GAP : 0;
  const avail = plan.bodyHeight - bannerH;
  let best: FitResult | null = null;
  let densest: FitResult | null = null;
  for (let columns = plan.minColumns; columns <= plan.maxColumns; columns++) {
    const columnWidth = columnWidthFor(plan.bodyWidth, columns);
    if (columnWidth < MIN_STREAM_WIDTH) break; // narrower would wrap long dish names → stop escalating
    const layout: ResolvedLayout = {
      mode: "columns",
      columns,
      columnWidth,
      maxInternalCols: 1, // flow rows are single-stream; the browser balances them across columns
      gap: plan.gap,
      bodyWidth: plan.bodyWidth,
      bodyHeight: plan.bodyHeight,
    };
    for (const key of REGISTER_ORDER) {
      const r = REGISTERS[key];
      const total =
        blocks.reduce((s, b) => s + blockHeight(b, sectionsByTitle, r, 1), 0) +
        Math.max(0, blocks.length - 1) * SECTION_GAP;
      const estCol = total / columns; // ≈ height of each balanced column
      const res: FitResult = {
        register: r,
        layout,
        contentHeight: plan.bodyHeight,
        usedHeight: estCol + bannerH,
        fill: (estCol + bannerH) / plan.bodyHeight,
        bannerHeight: bannerH,
      };
      if (estCol <= avail * COLUMNS_FILL) {
        // This is the largest register that fits at THIS column count. Keep the overall largest
        // register (fewest columns for it) across the whole search.
        if (
          !best ||
          registerRank(r.name) > registerRank(best.register.name) ||
          (registerRank(r.name) === registerRank(best.register.name) &&
            columns < best.layout.columns)
        ) {
          best = res;
        }
        break; // larger registers already tried (order is L,M,S); move to the next column count
      }
      densest = res; // densest so far = most columns, smallest register attempted
    }
  }
  return best ?? densest!;
}
