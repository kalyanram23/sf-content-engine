/**
 * The generic layout engine — pure sizing/column/layout logic, ASPECT-AWARE and THEME-AGNOSTIC.
 *
 * Given the resolved body blocks + the canvas, it (1) derives a LAYOUT PLAN from the canvas aspect,
 * (2) chooses ONE size register for the whole board and (3) — for non-portrait boards — distributes
 * the blocks across newspaper columns, so the content plausibly SPANS the canvas. Every theme-specific
 * number (content box, register metrics, stream width, section rhythm, banner height) arrives through
 * the `ComponentVocabulary`/`VocabularyMetrics` interfaces (D71) — the engine knows no theme CSS.
 *
 * Two layout modes:
 *   - "stack"   (portrait, h > w): full-width component stripes stacked top-to-bottom; a section may
 *     run 1–2 internal price-list columns; `justify-content:space-between` turns a modest under-fill
 *     into airy gaps.
 *   - "columns" (landscape, w ≥ h): the body is a BALANCED MULTI-COLUMN ROW FLOW. Sections render
 *     single-stream (one price row per line) and flow down column 1, spilling into column 2, etc; a
 *     long section SPLITS across a column boundary at a ROW boundary (its header is glued to its first
 *     row so it never orphans). The renderer draws this with CSS `column-count`/`column-fill:balance`,
 *     so column heights even out at row granularity — no whole-section lumps, no half-empty column.
 *     One photoBand, if present, is a full-width banner above the columns. Because balancing is now at
 *     row granularity, the fitter re-derives the register UPWARD: it picks the LARGEST register whose
 *     balanced flow (≈ total flow height / column count) still fits the body height under the banner.
 */

import type { CompositionBlock } from "../domain/contracts";
import type {
  ComponentVocabulary,
  VocabCanvas,
  VocabSection,
  VocabularyMetrics,
} from "../ports/vocabulary-registry";

const COL_GAP = 44; // gutter between newspaper columns (columns mode) == CSS column-gap
export const BANNER_GAP = 24; // space under a full-width filmstrip banner (columns mode)

// Fill targets (engine-generic): the largest register whose estimated height fits within this
// fraction of the body is chosen; the remainder becomes distributed air.
export const STACK_FILL = 0.92;
export const COLUMNS_FILL = 0.95;

// Bottom safety margin (engine-generic px). The landscape measured-overflow guard treats a column as
// overflowing when its measured height comes within this MUCH of the body height, so the tallest
// column's last row keeps a hair of breathing room below the bottom frame and any sub-pixel /
// residual face-metric error can't slip a price under it. Kept small on purpose: the measure document
// now loads the REAL theme faces (see the renderer's buildMeasureDoc), so wrapping matches the poster
// and the measured heights are accurate — this only guards the final couple of pixels.
export const COLUMNS_BOTTOM_SAFETY = 8;

export type LayoutMode = "stack" | "columns";

/** Canvas-derived plan (pre-fit): mode + the search space for the newspaper-column count. */
export interface LayoutPlan {
  mode: LayoutMode;
  bodyWidth: number;
  bodyHeight: number;
  gap: number;
  minColumns: number; // columns mode: start of the escalation search
  maxColumns: number; // columns mode: cap (keeps each column ≥ minStreamWidth)
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

export function columnWidthFor(bodyWidth: number, columns: number): number {
  return Math.floor((bodyWidth - (columns - 1) * COL_GAP) / columns);
}

/**
 * Derive the layout plan from the canvas aspect.
 *   portrait (h > w)      → stack (1 column, original behaviour)
 *   landscape (w ≥ h)     → balanced multi-column flow; the fitter searches the column count (2 →
 *     maxColumns, capped so each column stays ≥ `vocab.minStreamWidth`) jointly with the register,
 *     biasing to the LARGEST register (fewest columns for it). A non-portrait square canvas is treated
 *     as landscape — we no longer special-case square.
 */
export function planLayout(canvas: VocabCanvas, vocab: ComponentVocabulary): LayoutPlan {
  const box = vocab.contentBox(canvas);
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
  // How many minStreamWidth columns (plus their gutters) fit across the body.
  const maxColumns = Math.max(
    2,
    Math.floor((box.width + COL_GAP) / (vocab.minStreamWidth + COL_GAP)),
  );
  return {
    mode: "columns",
    bodyWidth: box.width,
    bodyHeight: box.height,
    gap: COL_GAP,
    minColumns: 2,
    maxColumns,
  };
}

/** Estimated height (px) a resolved body block consumes at metrics `m` with `maxInternalCols`. */
function blockHeight(
  block: CompositionBlock,
  sectionsByTitle: Map<string, VocabSection>,
  m: VocabularyMetrics,
  maxInternalCols: number,
): number {
  if (block.kind === "photoBand") return m.photoBandHeight();
  if (block.kind === "group") {
    const secs = block.sections
      .map((t) => sectionsByTitle.get(t))
      .filter((s): s is VocabSection => Boolean(s));
    const itemCounts = secs.map((s) => s.items.length); // each mini list is 1 internal column
    return m.groupHeight(itemCounts);
  }
  const sec = block.section ? sectionsByTitle.get(block.section) : undefined;
  const count = sec?.items.length ?? 0;
  return m.sectionHeight(count, m.sectionInternalCols(count, maxInternalCols));
}

// ── explicit measured-column partition (landscape flow) ─────────────────────────────────────────────
/** One measured flow unit for the partitioner: its true rendered height + whether it leads a section. */
export interface FlowUnitSize {
  height: number; // measured px (getBoundingClientRect height at the chosen register + column width)
  isLead: boolean; // true = a section's header+first-row unit; false = a continuation row
}

/**
 * Split a flat list of MEASURED flow units into `columns` contiguous groups, minimizing the TALLEST
 * column so the columns end within a small delta (the balance quality CSS `column-fill:balance` gave,
 * but now WE own the break points so the renderer can stamp a continuation cue at each column top).
 *
 * Hard rules honoured by construction:
 *   - a break may only land BETWEEN two units (groups are contiguous index ranges);
 *   - a section header can never be orphaned — the header + its first row are ONE unit upstream, so no
 *     break can fall between them.
 *
 * Balance model:
 *   - `sectionGap` is added before every lead unit, EXCEPT when the lead sits at a column top (no
 *     leading margin is rendered at a break), so that gap is dropped from that column's cost;
 *   - a column whose FIRST unit is a continuation row will carry a "<Section> (cont.)" cue, so `cueH`
 *     is charged to that column — the balancer compensates by handing cue columns slightly fewer rows
 *     (this is the "nudge the balance target rather than drop the register" the cue asks for).
 *
 * `sectionGap` defaults to the engine-generic `14`; `fit` and the renderer pass `vocab.sectionGap`.
 */
export function partitionColumns(
  units: FlowUnitSize[],
  columns: number,
  cueH: number,
  sectionGap = 14,
): number[][] {
  const m = units.length;
  if (columns <= 1 || m === 0) return [Array.from({ length: m }, (_, i) => i)];

  const step = units.map((u) => u.height + (u.isLead ? sectionGap : 0));
  const pre: number[] = [0];
  for (let i = 0; i < m; i++) pre.push(pre[i]! + step[i]!);

  // Cost of a column covering units [i..j]: sum of steps, minus the lead-gap we don't render at the
  // column top, plus a cue line when unit i is a continuation (its header is in an earlier column).
  const colCost = (i: number, j: number): number => {
    const raw = pre[j + 1]! - pre[i]!;
    const leadGapAtTop = units[i]!.isLead ? sectionGap : 0;
    const cue = units[i]!.isLead ? 0 : cueH;
    return raw - leadGapAtTop + cue;
  };

  // dp[c][i] = min achievable tallest-column height to split units[i..m-1] into c columns.
  const INF = Number.POSITIVE_INFINITY;
  const dp: number[][] = Array.from({ length: columns + 1 }, () => new Array(m + 1).fill(INF));
  for (let i = 0; i < m; i++) dp[1]![i] = colCost(i, m - 1);
  for (let c = 2; c <= columns; c++) {
    for (let i = 0; i <= m - c; i++) {
      let best = INF;
      for (let j = i; j <= m - c; j++) {
        const cand = Math.max(colCost(i, j), dp[c - 1]![j + 1]!);
        if (cand < best) best = cand;
      }
      dp[c]![i] = best;
    }
  }
  const target = dp[columns]![0]!; // the minimal possible tallest column

  // Greedy fill each column as full as possible without exceeding `target`, always leaving one unit
  // per remaining column. This reproduces the minimal-max partition as balanced columns.
  const groups: number[][] = [];
  let i = 0;
  for (let c = columns; c >= 1; c--) {
    if (c === 1) {
      groups.push(Array.from({ length: m - i }, (_, k) => i + k));
      break;
    }
    const maxJ = m - c; // leave c-1 units for the remaining columns
    let end = i; // at least one unit per column
    for (let j = i; j <= maxJ; j++) {
      if (colCost(i, j) <= target + 0.5) end = j;
      else break;
    }
    groups.push(Array.from({ length: end - i + 1 }, (_, k) => i + k));
    i = end + 1;
  }
  return groups;
}

export interface FitInput {
  blocks: CompositionBlock[]; // flowing blocks (stack: all; columns: everything except the banner)
  sectionsByTitle: Map<string, VocabSection>;
  plan: LayoutPlan;
  vocab: ComponentVocabulary;
  banner?: CompositionBlock | null; // columns mode: a full-width band reserved above the columns
}

export interface FitResult {
  register: string;
  layout: ResolvedLayout;
  contentHeight: number; // bodyHeight (px)
  usedHeight: number; // stack: total block height; columns: est. balanced column height + banner
  fill: number; // usedHeight / bodyHeight
  bannerHeight: number; // 0 in stack mode / when no banner
}

/**
 * Pick the layout that fits with the largest type.
 *
 *   stack:   pick the LARGEST register whose total estimated height ≤ STACK_FILL of the body (the rest
 *            becomes distributed air).
 *   columns: BALANCED ROW FLOW. Total flow height (single-stream section heights + inter-section
 *            gaps) balanced across N columns is ≈ total/N. Search (columns, register) jointly and
 *            keep the LARGEST register that fits — with the FEWEST columns for that register. More
 *            columns lets a bigger register fit (shorter balanced height), but a column may not be
 *            narrower than `vocab.minStreamWidth` (long dish names would wrap). Row-granularity
 *            balancing means no whole-section lump forces the type down.
 *
 * If nothing fits even at maxColumns/smallest register, return the densest attempt (renderer clips;
 * the screenshot reveals it — an honest broken board, never a silent lie).
 */
export function fit(input: FitInput): FitResult {
  const { blocks, sectionsByTitle, plan, vocab, banner } = input;

  // Register rank = reverse index in `registerNames` (largest-first order), so a bigger register
  // scores higher — mirrors the prototype's L>M>S ordering, now theme-supplied.
  const registerRank = (name: string): number =>
    vocab.registerNames.length - vocab.registerNames.indexOf(name);

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
    for (const name of vocab.registerNames) {
      const m = vocab.metrics(name);
      const used = blocks.reduce((s, b) => s + blockHeight(b, sectionsByTitle, m, 2), 0);
      const res: FitResult = {
        register: name,
        layout,
        contentHeight: plan.bodyHeight,
        usedHeight: used,
        fill: used / plan.bodyHeight,
        bannerHeight: 0,
      };
      if (used <= plan.bodyHeight * STACK_FILL) return res;
      last = res;
    }
    return last!;
  }

  // columns mode: balanced multi-column flow. Banner height is fixed (register-independent) so the
  // register search doesn't chase its own tail; sections flow single-stream (1 internal column).
  const bannerH = banner ? vocab.landscapeBannerHeight + BANNER_GAP : 0;
  const avail = plan.bodyHeight - bannerH;
  let best: FitResult | null = null;
  let densest: FitResult | null = null;
  for (let columns = plan.minColumns; columns <= plan.maxColumns; columns++) {
    const columnWidth = columnWidthFor(plan.bodyWidth, columns);
    if (columnWidth < vocab.minStreamWidth) break; // narrower would wrap long names → stop escalating
    const layout: ResolvedLayout = {
      mode: "columns",
      columns,
      columnWidth,
      maxInternalCols: 1, // flow rows are single-stream; the browser balances them across columns
      gap: plan.gap,
      bodyWidth: plan.bodyWidth,
      bodyHeight: plan.bodyHeight,
    };
    for (const name of vocab.registerNames) {
      const m = vocab.metrics(name);
      const total =
        blocks.reduce((s, b) => s + blockHeight(b, sectionsByTitle, m, 1), 0) +
        Math.max(0, blocks.length - 1) * vocab.sectionGap;
      const estCol = total / columns; // ≈ height of each balanced column
      const res: FitResult = {
        register: name,
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
          registerRank(name) > registerRank(best.register) ||
          (registerRank(name) === registerRank(best.register) && columns < best.layout.columns)
        ) {
          best = res;
        }
        break; // larger registers already tried (largest-first order); move to the next column count
      }
      densest = res; // densest so far = most columns, smallest register attempted
    }
  }
  return best ?? densest!;
}
