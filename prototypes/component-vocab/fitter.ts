/**
 * The fitter — pure sizing/column logic.
 *
 * Given the resolved body blocks + the canvas, choose ONE size register (L/M/S) for the whole board
 * and a column count per section, so the content plausibly SPANS the canvas (the content column uses
 * `justify-content:space-between`, so a modest under-fill becomes airy gaps — like the gold board).
 *
 * The three registers are anchored on the gold board's own numbers (M ≈ gold), scaled up (L) for a
 * sparse board and down (S) for a dense one. Row-height/pitch constants are adapted from the engine's
 * plan-time sizing ladder — src/planning/sizing.ts (D70): its comfortable ladder rungs are
 * text-3xl/2xl/xl at rowPx 110/62/44 and it distributes usable body height across rows-per-column to
 * pick a register. We copy that *idea* (register + proportional fill), not the code, at px scale.
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

export function contentBox(canvas: Canvas): { width: number; height: number } {
  return {
    width: canvas.width - 2 * FRAME - 2 * PAD_SIDE,
    height: canvas.height - 2 * FRAME - HEADER - PAD_TOP - PAD_BOTTOM,
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

/** Full-width section columns: 1 for ≤4 items, else 2 (gold never runs a full section past 2). */
export function sectionColumns(itemCount: number): number {
  return itemCount <= 4 ? 1 : 2;
}

export function collageBandHeight(r: Register): number {
  return r.cardPhotoH + r.captionFont * LINE + 22 + 34; // photo + caption + card padding + tilt slack
}

/** Estimated height (px) a resolved body block consumes at register `r`. */
function blockHeight(
  block: Block,
  sectionsByTitle: Map<string, ResolvedSection>,
  r: Register,
): number {
  if (block.type === "collage") return collageBandHeight(r);
  if (block.type === "triBand") {
    const secs = (block.sections ?? [])
      .map((t) => sectionsByTitle.get(t))
      .filter((s): s is ResolvedSection => Boolean(s));
    const maxRows = Math.max(1, ...secs.map((s) => s.items.length)); // each mini list is 1 column
    return headerH(r, true) + maxRows * rowH(r, true);
  }
  // section
  const sec = block.section ? sectionsByTitle.get(block.section) : undefined;
  const count = sec?.items.length ?? 0;
  const cols = sectionColumns(count);
  return headerH(r, false) + Math.ceil(count / cols) * rowH(r, false);
}

export interface FitResult {
  register: Register;
  contentHeight: number;
  usedHeight: number;
  fill: number;
}

/**
 * Pick the LARGEST register whose estimated total content height leaves room for the
 * space-between gaps (target ≤ 92% of the box, so the remaining ~8%+ becomes distributed air).
 * Falls back to S if even S overflows.
 */
export function fit(
  blocks: Block[],
  sectionsByTitle: Map<string, ResolvedSection>,
  canvas: Canvas,
): FitResult {
  const box = contentBox(canvas);
  const order: Array<"L" | "M" | "S"> = ["L", "M", "S"];
  let chosen: FitResult | null = null;
  for (const key of order) {
    const r = REGISTERS[key];
    const used = blocks.reduce((sum, b) => sum + blockHeight(b, sectionsByTitle, r), 0);
    const fill = used / box.height;
    if (used <= box.height * 0.92) {
      return { register: r, contentHeight: box.height, usedHeight: used, fill };
    }
    chosen = { register: r, contentHeight: box.height, usedHeight: used, fill };
  }
  // even S overflows — return S (renderer clips; screenshot reveals it).
  return chosen!;
}
