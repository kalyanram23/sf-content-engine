/**
 * Renderer — composition JSON → one self-contained HTML string.
 *
 * The LLM's `Composition` carries only judgment (title, block order, groupings, collage picks). This
 * file owns everything deterministic: it validates the type/field pairing, GUARANTEES coverage (any
 * section the LLM forgot is appended — the same "LLM judges, code guarantees the bookkeeping"
 * contract as the real engine's coverage.ts), enforces photo-truth (captions come from menu data),
 * asks the fitter for the layout plan + sizes, and expands the closed vocabulary into the final board.
 *
 * ASPECT AWARENESS lives here + in the fitter: a portrait canvas renders the original stacked stripes;
 * a landscape/square canvas reflows the same composition into newspaper columns with the photo
 * collage lifted into a full-width banner. The LLM's composition is identical either way — only the
 * deterministic layout adapts.
 */

import {
  masthead,
  polaroidCollage,
  priceList,
  priceRow,
  sectionHeader,
  triBand,
  TOKENS,
  type Block,
  type Canvas,
  type Composition,
  type MenuItem,
  type PhotoMode,
  type Register,
  type ResolvedSection,
} from "./catalog";
import {
  collageBandHeight,
  fit,
  LANDSCAPE_BANNER_H,
  planLayout,
  SECTION_GAP,
  sectionInternalCols,
  type FitResult,
  type LayoutPlan,
} from "./fitter";

const DIVIDER = "rgba(42,26,14,0.2)"; // vertical newspaper-column rule (matches catalog's DIVIDER)

export interface RenderContext {
  sections: ResolvedSection[];
  photoCandidates: MenuItem[];
  canvas: Canvas;
  tagline: string | null;
  /**
   * How every `collage` block renders (experiment knob — the LLM schema is unchanged). "collage" is the
   * static pile; "crossfade"/"filmstrip" are the pure-CSS carousels that cycle through ALL a block's
   * photos. Defaults to "collage".
   */
  photoMode?: PhotoMode;
}

/** Carousel modes may show many photos (they rotate through time); the static pile stays ≤5. */
function collageMax(mode: PhotoMode): number {
  return mode === "collage" ? 5 : 12;
}

export interface RenderResult {
  html: string;
  finalBlocks: Block[];
  fit: FitResult;
  warnings: string[];
}

/** Validate the type/field pairing and normalize; collect human-readable warnings. */
function normalizeBlocks(
  blocks: Block[],
  sectionsByTitle: Map<string, ResolvedSection>,
  warnings: string[],
): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.type === "section") {
      if (!b.section || !sectionsByTitle.has(b.section)) {
        warnings.push(
          `dropped section block with unknown/missing title: ${JSON.stringify(b.section)}`,
        );
        continue;
      }
      out.push({ type: "section", section: b.section });
    } else if (b.type === "triBand") {
      const known = (b.sections ?? []).filter((t) => sectionsByTitle.has(t));
      if (known.length < 2) {
        warnings.push(
          `triBand needs ≥2 known sections, got ${JSON.stringify(b.sections)} — demoting`,
        );
        for (const t of known) out.push({ type: "section", section: t });
        continue;
      }
      out.push({ type: "triBand", sections: known.slice(0, 3) });
    } else if (b.type === "collage") {
      out.push({ type: "collage", itemIds: b.itemIds ?? [] });
    }
  }
  return out;
}

/** Which section titles are already placed by section/triBand blocks. */
function coveredTitles(blocks: Block[]): Set<string> {
  const s = new Set<string>();
  for (const b of blocks) {
    if (b.type === "section" && b.section) s.add(b.section);
    if (b.type === "triBand") for (const t of b.sections ?? []) s.add(t);
  }
  return s;
}

/** Columns mode: expand every triBand into individual section blocks (columns supply the division). */
function expandTriBands(blocks: Block[]): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.type === "triBand") {
      for (const t of b.sections ?? []) out.push({ type: "section", section: t });
    } else {
      out.push(b);
    }
  }
  return out;
}

/** Resolve a collage block's ids into real photo items (photo-truth), clamped to 3–`max`. */
function resolveCollage(ids: string[], ctx: RenderContext, max = 5): MenuItem[] {
  const byId = new Map(ctx.photoCandidates.map((c) => [c.id, c]));
  const picked: MenuItem[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const it = byId.get(id);
    if (it && it.imageUrl && !seen.has(id)) {
      picked.push(it);
      seen.add(id);
    }
  }
  // pad to at least 3 from remaining candidates
  for (const c of ctx.photoCandidates) {
    if (picked.length >= 3) break;
    if (!seen.has(c.id) && c.imageUrl) {
      picked.push(c);
      seen.add(c.id);
    }
  }
  return picked.slice(0, max);
}

/**
 * Render a list of blocks into HTML, numbering sections from `startNumber` (numbering continues
 * across newspaper columns in reading order). `forceSingleCol` makes sections single-stream (columns
 * mode); `bandWidth` is the container width a collage strip must span.
 */
function renderBlockList(
  list: Block[],
  startNumber: number,
  r: FitResult["register"],
  ctx: RenderContext,
  sectionsByTitle: Map<string, ResolvedSection>,
  bandWidth: number,
  maxInternalCols: number,
): { html: string; endNumber: number } {
  let n = startNumber;
  const mode = ctx.photoMode ?? "collage";
  const parts = list.map((b, i) => {
    if (b.type === "collage") {
      const cards = resolveCollage(b.itemIds ?? [], ctx, collageMax(mode));
      if (cards.length === 0) return "";
      return polaroidCollage(cards, r, collageBandHeight(r), bandWidth, mode, `b${startNumber}_${i}`);
    }
    if (b.type === "triBand") {
      const secs = (b.sections ?? [])
        .map((t) => sectionsByTitle.get(t))
        .filter((s): s is ResolvedSection => Boolean(s));
      const start = n + 1;
      n += secs.length;
      return triBand(secs, start, r);
    }
    const sec = sectionsByTitle.get(b.section!)!;
    n += 1;
    const cols = sectionInternalCols(sec.items.length, maxInternalCols);
    return `<div>` + sectionHeader(n, sec.title, r) + priceList(sec.items, cols, r) + `</div>`;
  });
  return { html: parts.filter(Boolean).join(""), endNumber: n };
}

/** The shell: stripe frame + paper + masthead, with `bodyHtml` slotted into the paper column. */
function shell(ctx: RenderContext, comp: Composition, r: FitResult["register"], bodyHtml: string): string {
  const cssVars = Object.entries(TOKENS)
    .map(([k, v]) => `--color-${k}:${v}`)
    .join(";");
  return (
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<link rel="preconnect" href="https://fonts.googleapis.com">` +
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous">` +
    `<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=Shrikhand&display=swap" rel="stylesheet">` +
    `<style>:root{${cssVars}}*{box-sizing:border-box}body{margin:0}</style></head><body>` +
    `<div style="width:${ctx.canvas.width}px;height:${ctx.canvas.height}px;` +
    `background:repeating-linear-gradient(45deg,var(--color-accent) 0 16px,var(--color-stripe) 16px 32px);` +
    `padding:16px;box-sizing:border-box;overflow:hidden">` +
    `<div style="width:100%;height:100%;background:var(--color-bg);color:var(--color-text);` +
    `font-family:'Archivo',sans-serif;display:flex;flex-direction:column;overflow:hidden">` +
    masthead(comp.title, ctx.tagline, r) +
    bodyHtml +
    `</div></div></body></html>`
  );
}

/** Render the portrait stack body (original behaviour). */
function renderStack(
  comp: Composition,
  blocks: Block[],
  ctx: RenderContext,
  sectionsByTitle: Map<string, ResolvedSection>,
  plan: LayoutPlan,
): { html: string; f: FitResult; finalBlocks: Block[] } {
  const f = fit({ blocks, sectionsByTitle, plan });
  const { html: body } = renderBlockList(
    blocks,
    0,
    f.register,
    ctx,
    sectionsByTitle,
    f.layout.columnWidth,
    f.layout.maxInternalCols,
  );
  const inner =
    `<div style="flex:1;display:flex;flex-direction:column;justify-content:space-between;` +
    `padding:24px 36px 30px;min-height:0">${body}</div>`;
  return { html: shell(ctx, comp, f.register, inner), f, finalBlocks: blocks };
}

/**
 * One flowing section for the balanced multi-column body: header + rows as single-stream lines.
 * Break controls make the section SPLIT only at a row boundary and never orphan its header:
 *   - the header is GLUED to its first row inside one `break-inside:avoid` box (+ `break-after:avoid`),
 *     so a header can never sit alone at the bottom of a column;
 *   - every subsequent row is its own `break-inside:avoid` box, so the split always lands cleanly
 *     between two rows — the remaining rows continue seamlessly at the top of the next column.
 * `margin-bottom` (space AFTER, never a top margin) gives inter-section rhythm without opening a gap
 * at a column top when a section happens to start there.
 */
function flowSection(n: number, sec: ResolvedSection, r: Register, last: boolean): string {
  const avoid = "break-inside:avoid;-webkit-column-break-inside:avoid";
  const items = sec.items;
  const head =
    `<div style="${avoid};break-after:avoid;-webkit-column-break-after:avoid">` +
    sectionHeader(n, sec.title, r) +
    (items[0] ? priceRow(items[0], r, false) : "") +
    `</div>`;
  const rest = items
    .slice(1)
    .map((it) => `<div style="${avoid}">${priceRow(it, r, false)}</div>`)
    .join("");
  const mb = last ? "" : `margin-bottom:${SECTION_GAP}px`;
  return `<div style="${mb}">${head}${rest}</div>`;
}

/** Render the landscape balanced multi-column flow body. */
function renderColumns(
  comp: Composition,
  blocks: Block[],
  ctx: RenderContext,
  sectionsByTitle: Map<string, ResolvedSection>,
  plan: LayoutPlan,
): { html: string; f: FitResult; finalBlocks: Block[] } {
  const flat = expandTriBands(blocks);
  // Lift the first collage into a full-width filmstrip banner above the columns.
  const bannerIdx = flat.findIndex((b) => b.type === "collage");
  const banner: Block | null = bannerIdx >= 0 ? flat[bannerIdx]! : null;
  const flow = bannerIdx >= 0 ? flat.filter((_, i) => i !== bannerIdx) : flat;

  const f = fit({ blocks: flow, sectionsByTitle, plan, banner });
  const r = f.register;
  const { columns, gap, bodyWidth } = f.layout;

  const mode = ctx.photoMode ?? "collage";
  let bannerHtml = "";
  if (banner) {
    const cards = resolveCollage(banner.itemIds ?? [], ctx, collageMax(mode));
    if (cards.length) {
      bannerHtml =
        `<div style="flex:none;margin-bottom:24px">` +
        polaroidCollage(cards, r, LANDSCAPE_BANNER_H, bodyWidth, mode, "banner") +
        `</div>`;
    }
  }

  // Sections numbered 1..N in DOM (== reading) order; the browser balances where each break falls.
  const flowSecs = flow
    .map((b) => (b.type === "section" ? sectionsByTitle.get(b.section!) : undefined))
    .filter((s): s is ResolvedSection => Boolean(s));
  const flowHtml = flowSecs
    .map((sec, i) => flowSection(i + 1, sec, r, i === flowSecs.length - 1))
    .join("");

  // CSS multi-column: `column-fill:balance` evens the column heights at ROW granularity; `column-rule`
  // draws the vertical ink rule between columns (the newspaper divider, full body height).
  const body =
    `<div style="flex:1;min-height:0;column-count:${columns};column-gap:${gap}px;` +
    `column-rule:2px solid ${DIVIDER};column-fill:balance;overflow:hidden">${flowHtml}</div>`;

  const inner =
    `<div style="flex:1;display:flex;flex-direction:column;padding:24px 36px 30px;min-height:0">` +
    bannerHtml +
    body +
    `</div>`;

  const finalBlocks: Block[] = [
    ...(banner ? [banner] : []),
    ...flowSecs.map((s): Block => ({ type: "section", section: s.title })),
  ];
  return { html: shell(ctx, comp, r, inner), f, finalBlocks };
}

export function render(comp: Composition, ctx: RenderContext): RenderResult {
  const warnings: string[] = [];
  const sectionsByTitle = new Map(ctx.sections.map((s) => [s.title, s]));

  let blocks = normalizeBlocks(comp.blocks, sectionsByTitle, warnings);

  // COVERAGE GUARANTEE: append any section the LLM forgot as its own full-width block.
  const covered = coveredTitles(blocks);
  const missing = ctx.sections.filter((s) => !covered.has(s.title));
  if (missing.length > 0) {
    warnings.push(
      `coverage: appended ${missing.length} forgotten section(s): ${missing.map((s) => s.title).join(", ")}`,
    );
    for (const s of missing) blocks.push({ type: "section", section: s.title });
  }

  const layout = planLayout(ctx.canvas);
  const rendered =
    layout.mode === "columns"
      ? renderColumns(comp, blocks, ctx, sectionsByTitle, layout)
      : renderStack(comp, blocks, ctx, sectionsByTitle, layout);

  return {
    html: rendered.html,
    finalBlocks: rendered.finalBlocks,
    fit: rendered.f,
    warnings,
  };
}
