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
 *   - "columns" (landscape / square, w ≥ h): the body flows blocks into 2 newspaper columns so the
 *     board fills horizontally. Each section becomes a single-stream price list (1 internal column);
 *     triBands are expanded upstream into individual sections (the newspaper columns already supply
 *     the horizontal division triBand was faking); one photo collage, if present, is lifted into a
 *     full-width banner above the columns (see render.ts). Blocks are split into columns by a
 *     linear-partition DP that minimises the tallest column while preserving reading order.
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
const COL_GAP = 44; // gutter between newspaper columns (columns mode)
const BANNER_GAP = 24; // space under a full-width collage banner (columns mode)
const MIN_COL_WIDTH = 300; // don't make a newspaper column narrower than this
const INTERNAL_2COL_MIN = 560; // a newspaper column this wide can run 2 internal price columns

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
function internalColsFor(columnWidth: number): number {
  return columnWidth >= INTERNAL_2COL_MIN ? 2 : 1;
}

/**
 * Derive the layout plan from the canvas aspect.
 *   portrait (h > w)   → stack (1 column, original behaviour)
 *   landscape / square → newspaper columns; the fitter escalates the count (2 → maxColumns) until the
 *     content fits, because the wide/square body is SHORT (≈half the portrait body height) and a
 *     dense slice needs the extra columns to fill without overflowing.
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
  const maxColumns = Math.max(2, Math.min(4, Math.floor(box.width / MIN_COL_WIDTH)));
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

/**
 * Partition `heights` (in reading order) into `k` CONTIGUOUS groups minimising the largest group
 * sum (classic linear-partition DP — same idea as the engine's section balancer). Returns k
 * `[start, end)` index ranges; preserves order so newspaper columns read top-to-bottom.
 */
export function linearPartition(heights: number[], k: number): Array<[number, number]> {
  const n = heights.length;
  if (n === 0) return Array.from({ length: k }, () => [0, 0] as [number, number]);
  const kk = Math.max(1, Math.min(k, n));
  const prefix = [0];
  for (let i = 0; i < n; i++) prefix.push(prefix[i]! + heights[i]!);
  const rangeSum = (a: number, b: number): number => prefix[b]! - prefix[a]!;

  const dp: number[][] = Array.from({ length: n + 1 }, () => Array(kk + 1).fill(Infinity));
  const cut: number[][] = Array.from({ length: n + 1 }, () => Array(kk + 1).fill(0));
  dp[0]![0] = 0;
  for (let j = 1; j <= kk; j++) {
    for (let i = j; i <= n; i++) {
      for (let p = j - 1; p < i; p++) {
        const val = Math.max(dp[p]![j - 1]!, rangeSum(p, i));
        if (val < dp[i]![j]!) {
          dp[i]![j] = val;
          cut[i]![j] = p;
        }
      }
    }
  }
  const ranges: Array<[number, number]> = [];
  let i = n;
  let j = kk;
  while (j > 0) {
    const p = cut[i]![j]!;
    ranges.unshift([p, i]);
    i = p;
    j--;
  }
  // Pad to exactly k groups (trailing empties) if fewer blocks than columns.
  while (ranges.length < k) ranges.push([n, n]);
  return ranges;
}

export interface FitInput {
  blocks: Block[]; // flowing blocks (stack: all; columns: everything except the extracted banner)
  sectionsByTitle: Map<string, ResolvedSection>;
  plan: LayoutPlan;
  banner?: Block | null; // columns mode: a full-width collage band reserved above the columns
}

export interface FitResult {
  register: Register;
  layout: ResolvedLayout;
  contentHeight: number; // bodyHeight (px)
  usedHeight: number; // stack: total block height; columns: tallest column + banner
  fill: number; // usedHeight / bodyHeight
  bannerHeight: number; // 0 in stack mode / when no banner
  columnBlocks?: Block[][]; // columns mode: blocks assigned to each newspaper column
  columnHeights?: number[]; // columns mode: estimated content height of each column (px)
}

const REGISTER_ORDER: Array<"L" | "M" | "S"> = ["L", "M", "S"];

/**
 * Pick the layout that fits with the largest type and the fewest columns.
 *
 *   stack:   pick the LARGEST register whose total estimated height ≤ 92% of the body (the rest
 *            becomes distributed air).
 *   columns: escalate the newspaper-column count from 2 upward; at each count take the LARGEST
 *            register whose tallest column ≤ 94% of the body height left after the banner. The first
 *            (fewest-columns) count that admits any register wins — so we stay as readable as the
 *            short body allows and only add columns when the content demands it.
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

  // columns mode: escalate column count, prefer fewest columns / largest register.
  let densest: FitResult | null = null;
  for (let columns = plan.minColumns; columns <= plan.maxColumns; columns++) {
    const columnWidth = columnWidthFor(plan.bodyWidth, columns);
    const maxInternalCols = internalColsFor(columnWidth);
    const layout: ResolvedLayout = {
      mode: "columns",
      columns,
      columnWidth,
      maxInternalCols,
      gap: plan.gap,
      bodyWidth: plan.bodyWidth,
      bodyHeight: plan.bodyHeight,
    };
    for (const key of REGISTER_ORDER) {
      const r = REGISTERS[key];
      const bannerH = banner ? collageBandHeight(r) + BANNER_GAP : 0;
      const avail = plan.bodyHeight - bannerH;
      const heights = blocks.map((b) => blockHeight(b, sectionsByTitle, r, maxInternalCols));
      const ranges = linearPartition(heights, columns);
      const colSums = ranges.map(([a, b]) => heights.slice(a, b).reduce((s, h) => s + h, 0));
      const used = colSums.length ? Math.max(...colSums) : 0;
      const res: FitResult = {
        register: r,
        layout,
        contentHeight: plan.bodyHeight,
        usedHeight: used + bannerH,
        fill: (used + bannerH) / plan.bodyHeight,
        bannerHeight: bannerH,
        columnBlocks: ranges.map(([a, b]) => blocks.slice(a, b)),
        columnHeights: colSums,
      };
      if (used <= avail * 0.94) return res;
      densest = res; // densest so far = most columns, smallest register attempted
    }
  }
  return densest!;
}
