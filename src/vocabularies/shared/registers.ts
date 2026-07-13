/**
 * Shared vocabulary toolbox — REGISTER METRICS math. A theme declares per-register pixel numbers
 * (row/header heights etc. at its own type scale); this turns them into the `VocabularyMetrics`
 * height-estimate functions the generic layout engine fits boards with (register search, stack
 * fill, landscape column estimates). Same shape as the dhaba reference's `metricsFor`.
 */

import type { VocabularyMetrics } from "../../ports/vocabulary-registry";

/** Per-register pixel numbers a theme derives from its type scale. All heights in px. */
export interface RegisterMetricNumbers {
  /** One full-width price row, including its vertical padding. */
  rowHeight: number;
  /** A full-width section header, including its bottom margin. */
  headerHeight: number;
  /** One row inside a side-by-side group (the "small" variant). */
  smallRowHeight: number;
  /** A group member's header (the "small" variant). */
  smallHeaderHeight: number;
  /** The photo band at this register (stack mode). */
  photoBandHeight: number;
  /** The landscape continuation-cue line. */
  cueHeight: number;
  /** Item count at/below which a section stays single-column (default 4, like dhaba). */
  singleColumnMax?: number;
}

/** Build the layout engine's `VocabularyMetrics` from a theme's register numbers. */
export function metricsFromNumbers(n: RegisterMetricNumbers): VocabularyMetrics {
  const singleColumnMax = n.singleColumnMax ?? 4;
  return {
    sectionHeight: (itemCount, internalCols) =>
      n.headerHeight + Math.ceil(itemCount / Math.max(1, internalCols)) * n.rowHeight,
    // An all-unknown group can hand in an EMPTY array; the leading `1` floors the fold so an
    // empty array yields Math.max(1) = 1 (not Math.max() = -Infinity).
    groupHeight: (itemCounts) =>
      n.smallHeaderHeight + Math.max(1, ...itemCounts) * n.smallRowHeight,
    photoBandHeight: () => n.photoBandHeight,
    flowRowHeight: () => n.rowHeight,
    flowLeadHeight: () => n.headerHeight + n.rowHeight,
    cueHeight: () => n.cueHeight,
    sectionInternalCols: (itemCount, max) => (itemCount <= singleColumnMax ? 1 : max),
  };
}
