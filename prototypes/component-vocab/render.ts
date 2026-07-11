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
  continuationCue,
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
  partitionColumns,
  planLayout,
  SECTION_GAP,
  sectionInternalCols,
  type FitResult,
  type FlowUnitSize,
  type LayoutPlan,
} from "./fitter";

const DIVIDER = "rgba(42,26,14,0.2)"; // vertical newspaper-column rule (matches catalog's DIVIDER)

// The <head> that loads the board fonts (Shrikhand + Archivo). Shared by the live shell AND the
// off-screen MEASURE document so measured row/header heights use the SAME loaded faces as the board.
const FONT_HEAD =
  `<meta charset="utf-8">` +
  `<link rel="preconnect" href="https://fonts.googleapis.com">` +
  `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous">` +
  `<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=Shrikhand&display=swap" rel="stylesheet">`;

/**
 * A MEASURE port: given a self-contained HTML document (with `data-mk`-tagged elements), return each
 * element's rendered height keyed by its `data-mk`. The landscape flow injects this so it can partition
 * explicit columns off TRUE heights (fonts loaded) instead of leaving the break points to CSS. The
 * caller (compose.ts) fulfils it with Playwright, in the same browser run as the final screenshot.
 */
export type Measurer = (measureHtml: string) => Promise<Record<string, number>>;

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

/** Per-column diagnostics for the measured landscape flow (undefined for stack / CSS-fallback). */
export interface ColumnPlan {
  columns: number;
  register: Register["name"];
  columnHeights: number[]; // measured content height of each column (rows + gaps + cue), px
  avail: number; // body height available to the columns (bodyHeight − banner), px
  balanceDelta: number; // tallest − shortest column height, px
  overflow: boolean; // true if any column exceeds `avail` (would clip)
  cues: Array<{ column: number; section: string }>; // 1-based columns that got a "(cont.)" cue
}

export interface RenderResult {
  html: string;
  finalBlocks: Block[];
  fit: FitResult;
  warnings: string[];
  columnPlan?: ColumnPlan;
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
    `<!DOCTYPE html><html><head>` +
    FONT_HEAD +
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

/**
 * One atomic flow unit for the measured landscape flow. A section becomes: one LEAD unit (numbered
 * header GLUED to its first row — the pairing that guarantees a header is never orphaned at a column
 * top or bottom) followed by one unit per remaining row. The partitioner may break between any two
 * units but never inside one, so a break always lands cleanly between two rows.
 */
interface FlowUnit {
  mk: string; // measure key ("u0","u1",…) matched back to a measured height
  sectionTitle: string;
  isLead: boolean;
  html: string; // rendered at the chosen register; re-used verbatim in the measure doc AND the board
}

/** Expand the flowing sections into atomic units, numbering sections 1..N in reading order. */
function buildFlowUnits(secs: ResolvedSection[], r: Register): FlowUnit[] {
  const units: FlowUnit[] = [];
  secs.forEach((sec, i) => {
    const items = sec.items;
    units.push({
      mk: `u${units.length}`,
      sectionTitle: sec.title,
      isLead: true,
      html: sectionHeader(i + 1, sec.title, r) + (items[0] ? priceRow(items[0], r, false) : ""),
    });
    for (const it of items.slice(1)) {
      units.push({
        mk: `u${units.length}`,
        sectionTitle: sec.title,
        isLead: false,
        html: priceRow(it, r, false),
      });
    }
  });
  return units;
}

/**
 * The off-screen MEASURE document: every flow unit stacked in a single column of the EXACT newspaper
 * column width, at the chosen register, plus one sample continuation cue (`__cue__`). The measurer
 * loads it, waits for the fonts, and reports each `data-mk`'s true height so the partitioner balances
 * off real metrics. Same fonts/tokens/`box-sizing` as the board so heights transfer 1:1.
 */
function buildMeasureDoc(r: Register, columnWidth: number, units: FlowUnit[]): string {
  const cssVars = Object.entries(TOKENS)
    .map(([k, v]) => `--color-${k}:${v}`)
    .join(";");
  const rows = units.map((u) => `<div data-mk="${u.mk}">${u.html}</div>`).join("");
  const sampleTitle = units.reduce((a, u) => (u.sectionTitle.length > a.length ? u.sectionTitle : a), "Section");
  const cue = `<div data-mk="__cue__">${continuationCue(sampleTitle, r)}</div>`;
  return (
    `<!DOCTYPE html><html><head>` +
    FONT_HEAD +
    `<style>:root{${cssVars}}*{box-sizing:border-box}body{margin:0}</style></head><body>` +
    `<div style="width:${columnWidth}px;font-family:'Archivo',sans-serif;color:var(--color-text)">` +
    rows +
    cue +
    `</div></body></html>`
  );
}

/** Assemble the shared banner + finalBlocks used by both the measured and CSS-fallback column paths. */
function columnsShared(
  blocks: Block[],
  ctx: RenderContext,
  sectionsByTitle: Map<string, ResolvedSection>,
  plan: LayoutPlan,
): {
  f: FitResult;
  r: Register;
  bannerHtml: string;
  flowSecs: ResolvedSection[];
  finalBlocks: Block[];
  banner: Block | null;
} {
  const flat = expandTriBands(blocks);
  // Lift the first collage into a full-width filmstrip banner above the columns.
  const bannerIdx = flat.findIndex((b) => b.type === "collage");
  const banner: Block | null = bannerIdx >= 0 ? flat[bannerIdx]! : null;
  const flow = bannerIdx >= 0 ? flat.filter((_, i) => i !== bannerIdx) : flat;

  const f = fit({ blocks: flow, sectionsByTitle, plan, banner });
  const r = f.register;
  const { bodyWidth } = f.layout;

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

  const flowSecs = flow
    .map((b) => (b.type === "section" ? sectionsByTitle.get(b.section!) : undefined))
    .filter((s): s is ResolvedSection => Boolean(s));
  const finalBlocks: Block[] = [
    ...(banner ? [banner] : []),
    ...flowSecs.map((s): Block => ({ type: "section", section: s.title })),
  ];
  return { f, r, bannerHtml, flowSecs, finalBlocks, banner };
}

/**
 * Render the landscape flow body with EXPLICIT MEASURED COLUMNS (the default when a `measure` port is
 * available). We keep the register the fitter picked and the column count it chose, MEASURE every
 * header/row at that register + column width, then partition the units into balanced columns OURSELVES
 * — so we know which section leads each column and can stamp a "<Section> (cont.)" cue on any column
 * that opens mid-section. Falls back to the CSS `column-fill:balance` body (no cues) when no measurer
 * is supplied.
 */
async function renderColumns(
  comp: Composition,
  blocks: Block[],
  ctx: RenderContext,
  sectionsByTitle: Map<string, ResolvedSection>,
  plan: LayoutPlan,
  measure: Measurer | undefined,
  warnings: string[],
): Promise<{ html: string; f: FitResult; finalBlocks: Block[]; columnPlan?: ColumnPlan }> {
  const { f, r, bannerHtml, flowSecs, finalBlocks } = columnsShared(blocks, ctx, sectionsByTitle, plan);
  const { columns, gap, columnWidth } = f.layout;

  // ── CSS-balance fallback (no measurer): original behaviour, no continuation cues ──
  if (!measure) {
    const flowHtml = flowSecs
      .map((sec, i) => flowSection(i + 1, sec, r, i === flowSecs.length - 1))
      .join("");
    const body =
      `<div style="flex:1;min-height:0;column-count:${columns};column-gap:${gap}px;` +
      `column-rule:2px solid ${DIVIDER};column-fill:balance;overflow:hidden">${flowHtml}</div>`;
    const inner =
      `<div style="flex:1;display:flex;flex-direction:column;padding:24px 36px 30px;min-height:0">` +
      bannerHtml +
      body +
      `</div>`;
    return { html: shell(ctx, comp, r, inner), f, finalBlocks };
  }

  // ── measured explicit columns ──
  const units = buildFlowUnits(flowSecs, r);
  const heights = await measure(buildMeasureDoc(r, columnWidth, units));
  const fallbackH = (u: FlowUnit): number =>
    u.isLead ? r.sectionTitle * 1.4 + r.rowName * 1.4 : r.rowName * 1.4; // safety net only
  const sizes: FlowUnitSize[] = units.map((u) => ({
    height: heights[u.mk] ?? fallbackH(u),
    isLead: u.isLead,
  }));
  const cueH = heights["__cue__"] ?? r.sectionTitle * 0.66 * 1.1 + r.headerMb;

  const groups = partitionColumns(sizes, columns, cueH);

  // Emit each column; stamp the cue when its first unit is a continuation row.
  const avail = f.contentHeight - f.bannerHeight;
  const cues: Array<{ column: number; section: string }> = [];
  const columnHeights: number[] = [];
  const columnHtml = groups.map((idxs, colIdx) => {
    const colUnits = idxs.map((k) => units[k]!);
    const first = colUnits[0];
    let cueHtml = "";
    if (first && !first.isLead) {
      cueHtml = continuationCue(first.sectionTitle, r);
      cues.push({ column: colIdx + 1, section: first.sectionTitle });
    }
    let h = cueHtml ? cueH : 0;
    const inner = colUnits
      .map((u, idx) => {
        const gapTop = idx > 0 && u.isLead;
        h += sizes[idxs[idx]!]!.height + (gapTop ? SECTION_GAP : 0);
        return `<div style="${gapTop ? `margin-top:${SECTION_GAP}px` : ""}">${u.html}</div>`;
      })
      .join("");
    columnHeights.push(h);
    return `<div style="width:${columnWidth}px;flex:none">${cueHtml}${inner}</div>`;
  });

  // Explicit sibling columns with full-height vertical ink rules centred in each gutter (the same
  // newspaper divider the CSS `column-rule` drew).
  const rulePad = (gap - 2) / 2;
  const divider = `<div style="width:2px;flex:none;background:${DIVIDER};margin:0 ${rulePad}px"></div>`;
  const body =
    `<div style="flex:1;min-height:0;display:flex;align-items:stretch;overflow:hidden">` +
    columnHtml.join(divider) +
    `</div>`;
  const inner =
    `<div style="flex:1;display:flex;flex-direction:column;padding:24px 36px 30px;min-height:0">` +
    bannerHtml +
    body +
    `</div>`;

  const tallest = Math.max(...columnHeights);
  const overflow = tallest > avail + 1;
  if (overflow) {
    warnings.push(
      `columns overflow: tallest column ${tallest.toFixed(0)}px > available ${avail.toFixed(0)}px at register ${r.name}`,
    );
  }
  const columnPlan: ColumnPlan = {
    columns,
    register: r.name,
    columnHeights: columnHeights.map((x) => Math.round(x)),
    avail: Math.round(avail),
    balanceDelta: Math.round(tallest - Math.min(...columnHeights)),
    overflow,
    cues,
  };
  return { html: shell(ctx, comp, r, inner), f, finalBlocks, columnPlan };
}

export async function render(
  comp: Composition,
  ctx: RenderContext,
  measure?: Measurer,
): Promise<RenderResult> {
  const warnings: string[] = [];
  const sectionsByTitle = new Map(ctx.sections.map((s) => [s.title, s]));

  const blocks = normalizeBlocks(comp.blocks, sectionsByTitle, warnings);

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
  if (layout.mode === "columns") {
    const rendered = await renderColumns(comp, blocks, ctx, sectionsByTitle, layout, measure, warnings);
    return {
      html: rendered.html,
      finalBlocks: rendered.finalBlocks,
      fit: rendered.f,
      warnings,
      ...(rendered.columnPlan ? { columnPlan: rendered.columnPlan } : {}),
    };
  }
  const rendered = renderStack(comp, blocks, ctx, sectionsByTitle, layout);
  return {
    html: rendered.html,
    finalBlocks: rendered.finalBlocks,
    fit: rendered.f,
    warnings,
  };
}
