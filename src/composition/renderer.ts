/**
 * Generic renderer — a composition + a component vocabulary → ONE self-contained, engine-legal HTML
 * string. Theme-agnostic sibling of the prototype `render.ts`: the LLM's {@link CompositionResponse}
 * carries only judgment (title, block order, groupings, photo picks); this file owns everything
 * deterministic — it validates the kind/field pairing, GUARANTEES coverage (any section the LLM forgot
 * is appended: the same "LLM judges, code guarantees the bookkeeping" contract as coverage.ts),
 * enforces photo-truth (captions come from menu data), asks the layout engine for the plan + sizes, and
 * expands the CLOSED component vocabulary into the final board. Every theme touchpoint — component
 * markup, size registers, section rhythm, banner height — is reached through the injected
 * {@link ComponentVocabulary}; this file knows no theme CSS.
 *
 * ASPECT AWARENESS lives here + in the layout engine: a portrait canvas renders stacked stripes; a
 * landscape/square canvas reflows the SAME composition into balanced newspaper columns with the photo
 * band lifted into a full-width banner. When a `measure` port is supplied the landscape flow measures
 * true row/header heights and partitions EXPLICIT columns itself (so it can stamp "<Section> (cont.)"
 * cues at a spilled column top); without one it falls back to CSS `column-fill:balance` (no cues).
 */

import type { BrandInput } from "../domain/types";
import type { CompositionBlock, CompositionResponse } from "../domain/contracts";
import type { MeasureRequest } from "../ports/browser";
import type {
  ComponentVocabulary,
  PhotoBandMode,
  VocabCanvas,
  VocabItem,
  VocabSection,
} from "../ports/vocabulary-registry";
import {
  BANNER_GAP,
  fit,
  partitionColumns,
  planLayout,
  type FitResult,
  type FlowUnitSize,
  type LayoutPlan,
} from "./layout";

/** Bound from {@link BrowserPort.measure}: measure a document, get each `[data-mk]` height (px). */
type Measurer = (req: MeasureRequest) => Promise<Record<string, number>>;

export interface RenderComposedInput {
  composition: CompositionResponse;
  sections: VocabSection[];
  photoCandidates: VocabItem[]; // items eligible for photoBand (imageSlot ∩ hasImage)
  canvas: VocabCanvas;
  tagline: string | null;
  vocab: ComponentVocabulary;
  photoMode: PhotoBandMode;
  brand?: BrandInput;
  measure?: Measurer;
  /** Theme color tokens, declared as CSS vars on a wrapper around the shell. */
  colorTokens: Readonly<Record<string, string>>;
  /** Font family tokens for the measure document (font-dependent heights). */
  fontFamilies: Readonly<Record<string, string>>;
}

/** Per-column diagnostics for the measured landscape flow (undefined for stack / CSS-fallback). */
export interface ColumnPlan {
  columns: number;
  register: string;
  columnHeights: number[]; // measured content height of each column (rows + gaps + cue), px
  avail: number; // body height available to the columns (bodyHeight − banner), px
  balanceDelta: number; // tallest − shortest column height, px
  overflow: boolean; // true if any column exceeds `avail` (would clip)
  cues: Array<{ column: number; section: string }>; // 1-based columns that got a "(cont.)" cue
}

export interface RenderComposedResult {
  html: string; // single root element, engine-legal
  finalBlocks: CompositionBlock[];
  fit: FitResult;
  warnings: string[];
  columnPlan?: ColumnPlan;
}

// ── block constructors (strict-mode CompositionBlock: every field present, "" / [] sentinels) ────────
const sectionBlock = (section: string): CompositionBlock => ({
  kind: "section",
  section,
  sections: [],
  itemIds: [],
});
const groupBlock = (sections: string[]): CompositionBlock => ({
  kind: "group",
  section: "",
  sections,
  itemIds: [],
});
const photoBandBlock = (itemIds: string[]): CompositionBlock => ({
  kind: "photoBand",
  section: "",
  sections: [],
  itemIds,
});

/** Carousel modes may show many photos (they rotate through time); the static pile stays ≤5. */
function collageMax(mode: PhotoBandMode): number {
  return mode === "static" ? 5 : 12;
}

/** `--color-<name>:<value>;…` for every color token — declared on the composed-root wrapper. */
function cssVars(colorTokens: Readonly<Record<string, string>>): string {
  return Object.entries(colorTokens)
    .map(([k, v]) => `--color-${k}:${v}`)
    .join(";");
}

/**
 * The newspaper column rule / divider ink. Derived from the theme's TEXT token at low alpha (matches the
 * prototype's `rgba(42,26,14,0.2)` for the dhaba theme, whose text is #2a1a0e) so the theme-agnostic
 * renderer stays token-pure instead of baking a theme ink.
 */
const RULE = "color-mix(in srgb,var(--color-text) 20%,transparent)";

/** Validate the kind/field pairing and normalize; collect human-readable warnings. */
function normalizeBlocks(
  blocks: CompositionBlock[],
  sectionsByTitle: Map<string, VocabSection>,
  warnings: string[],
): CompositionBlock[] {
  const out: CompositionBlock[] = [];
  for (const b of blocks) {
    if (b.kind === "section") {
      if (!b.section || !sectionsByTitle.has(b.section)) {
        warnings.push(
          `dropped section block with unknown/missing title: ${JSON.stringify(b.section)}`,
        );
        continue;
      }
      out.push(sectionBlock(b.section));
    } else if (b.kind === "group") {
      const known = (b.sections ?? []).filter((t) => sectionsByTitle.has(t));
      if (known.length < 2) {
        warnings.push(
          `group needs ≥2 known sections, got ${JSON.stringify(b.sections)} — demoting`,
        );
        for (const t of known) out.push(sectionBlock(t));
        continue;
      }
      out.push(groupBlock(known.slice(0, 3)));
    } else if (b.kind === "photoBand") {
      out.push(photoBandBlock(b.itemIds ?? []));
    }
  }
  return out;
}

/** Which section titles are already placed by section/group blocks. */
function coveredTitles(blocks: CompositionBlock[]): Set<string> {
  const s = new Set<string>();
  for (const b of blocks) {
    if (b.kind === "section" && b.section) s.add(b.section);
    if (b.kind === "group") for (const t of b.sections) s.add(t);
  }
  return s;
}

/** Columns mode: expand every group into individual section blocks (columns supply the division). */
function expandGroups(blocks: CompositionBlock[]): CompositionBlock[] {
  const out: CompositionBlock[] = [];
  for (const b of blocks) {
    if (b.kind === "group") {
      for (const t of b.sections) out.push(sectionBlock(t));
    } else {
      out.push(b);
    }
  }
  return out;
}

/**
 * Resolve a photoBand block's ids into real photo items (photo-truth), clamped to 3–`max` (D72: keys on
 * `hasImage`, not an imageUrl presence).
 *
 * SLOT-COVERAGE GUARANTEE (mirrors this file's section coverage guarantee + coverage.ts: the LLM judges,
 * code guarantees the bookkeeping). After the composer's explicit picks and BEFORE generic padding, every
 * DISTINCT per-section slot among the candidates gets ≥1 card in the band, so each card's
 * `data-image-slot="<slot>"` satisfies `checkImageSlots`. Board-level items carry no slot (the band root's
 * `data-image-slot="shared"` satisfies them). If the distinct slots exceed the band's `max` capacity, keep
 * as many as fit and push a warning — an honest partial, never a silent drop.
 */
function resolveCollage(
  ids: string[],
  photoCandidates: VocabItem[],
  max: number,
  warnings: string[],
): VocabItem[] {
  const byId = new Map(photoCandidates.map((c) => [c.id, c]));
  const picked: VocabItem[] = [];
  const seen = new Set<string>();
  const take = (c: VocabItem): void => {
    picked.push(c);
    seen.add(c.id);
  };
  // 1. The composer's explicit picks — judgment (known id + hasImage, de-duplicated, in order).
  for (const id of ids) {
    const it = byId.get(id);
    if (it && it.hasImage && !seen.has(id)) take(it);
  }
  // 2. Slot-coverage guarantee: ≥1 card per distinct per-section slot, within the `max` clamp.
  const covered = new Set(picked.map((c) => c.slot).filter((s): s is string => s !== undefined));
  const distinctSlots = [
    ...new Set(photoCandidates.map((c) => c.slot).filter((s): s is string => s !== undefined)),
  ];
  for (const slot of distinctSlots) {
    if (covered.has(slot)) continue;
    const card = photoCandidates.find((c) => c.slot === slot && c.hasImage && !seen.has(c.id));
    if (card === undefined) continue; // the slot's photos are all already picked under the composer's ids
    if (picked.length >= max) {
      warnings.push(
        `photo band: ${distinctSlots.length} image slots exceed the ${max}-card band — ` +
          `slot "${slot}" is not represented in the collage.`,
      );
      break;
    }
    take(card);
    covered.add(slot);
  }
  // 3. Pad to at least 3 from any remaining candidates (generic padding).
  for (const c of photoCandidates) {
    if (picked.length >= 3) break;
    if (!seen.has(c.id) && c.hasImage) take(c);
  }
  return picked.slice(0, max);
}

/**
 * Render a list of blocks into HTML, numbering sections from `startNumber` (numbering continues across
 * newspaper columns in reading order). `bandWidth` is the container width a photo band must span.
 */
function renderBlockList(
  list: CompositionBlock[],
  startNumber: number,
  register: string,
  input: RenderComposedInput,
  sectionsByTitle: Map<string, VocabSection>,
  bandWidth: number,
  maxInternalCols: number,
  warnings: string[],
): { html: string; endNumber: number } {
  const { vocab, photoMode, photoCandidates } = input;
  const m = vocab.metrics(register);
  let n = startNumber;
  const parts = list.map((b, i) => {
    if (b.kind === "photoBand") {
      const cards = resolveCollage(b.itemIds, photoCandidates, collageMax(photoMode), warnings);
      if (cards.length === 0) return "";
      return vocab.renderPhotoBand({
        items: cards,
        register,
        bandHeight: m.photoBandHeight(),
        bandWidth,
        mode: photoMode,
        uid: `b${startNumber}_${i}`,
      });
    }
    if (b.kind === "group") {
      const secs = b.sections
        .map((t) => sectionsByTitle.get(t))
        .filter((s): s is VocabSection => Boolean(s));
      const start = n + 1;
      n += secs.length;
      return vocab.renderGroup({ startNumber: start, sections: secs, register });
    }
    const sec = sectionsByTitle.get(b.section)!;
    n += 1;
    const cols = m.sectionInternalCols(sec.items.length, maxInternalCols);
    return vocab.renderSection({ number: n, section: sec, internalCols: cols, register });
  });
  return { html: parts.filter(Boolean).join(""), endNumber: n };
}

/**
 * Wrap the vocabulary's shell so the composed ROOT the QA sees OWNS THE TOKENS (D72): the vocabulary
 * output stays token-pure (references `var(--color-*)`), and this wrapper declares every
 * `--color-<name>` inline and re-stamps the shell's `data-composed` value on itself.
 */
function buildShell(
  comp: CompositionResponse,
  input: RenderComposedInput,
  register: string,
  bodyHtml: string,
): string {
  const shellHtml = input.vocab.renderShell({
    title: comp.title,
    tagline: input.tagline,
    canvas: input.canvas,
    register,
    bodyHtml,
    ...(input.brand !== undefined ? { brand: input.brand } : {}),
  });
  const composed = shellHtml.match(/data-composed="([^"]*)"/)?.[1] ?? "";
  return `<div data-composed="${composed}" style="${cssVars(input.colorTokens)}">${shellHtml}</div>`;
}

/** Render the portrait stack body (component stripes stacked top-to-bottom). */
function renderStack(
  comp: CompositionResponse,
  blocks: CompositionBlock[],
  input: RenderComposedInput,
  sectionsByTitle: Map<string, VocabSection>,
  plan: LayoutPlan,
  warnings: string[],
): { html: string; f: FitResult; finalBlocks: CompositionBlock[] } {
  const f = fit({ blocks, sectionsByTitle, plan, vocab: input.vocab });
  const { html: body } = renderBlockList(
    blocks,
    0,
    f.register,
    input,
    sectionsByTitle,
    f.layout.columnWidth,
    f.layout.maxInternalCols,
    warnings,
  );
  // Body inset (padding) is owned by the vocabulary shell — this stays theme-agnostic and only sets the
  // stack's own layout: fill the shell's padded body box and distribute the stripes top-to-bottom.
  const inner =
    `<div style="flex:1;display:flex;flex-direction:column;justify-content:space-between;` +
    `min-height:0">${body}</div>`;
  return { html: buildShell(comp, input, f.register, inner), f, finalBlocks: blocks };
}

/**
 * One flowing section for the CSS-balance fallback body: header GLUED to its first row inside one
 * `break-inside:avoid` box (so the header never orphans), each subsequent row its own avoid box (so the
 * split always lands cleanly between two rows). `margin-bottom` gives inter-section rhythm without
 * opening a gap at a column top when a section starts there.
 */
function flowSection(
  n: number,
  sec: VocabSection,
  register: string,
  last: boolean,
  vocab: ComponentVocabulary,
): string {
  const avoid = "break-inside:avoid;-webkit-column-break-inside:avoid";
  const head =
    `<div style="${avoid};break-after:avoid;-webkit-column-break-after:avoid">` +
    vocab.renderFlowLead({ number: n, section: sec, register }) +
    `</div>`;
  const rest = sec.items
    .slice(1)
    .map((it) => `<div style="${avoid}">${vocab.renderFlowRow({ item: it, register })}</div>`)
    .join("");
  const mb = last ? "" : `margin-bottom:${vocab.sectionGap}px`;
  return `<div style="${mb}">${head}${rest}</div>`;
}

/**
 * One atomic flow unit for the measured landscape flow. A section becomes one LEAD unit (numbered
 * header GLUED to its first row — never orphaned) followed by one unit per remaining row. The
 * partitioner may break between any two units but never inside one. `renderFlowLead` may return TWO
 * sibling elements (header + first row); both are kept in the unit's `html` and concatenated.
 */
interface FlowUnit {
  mk: string; // measure key ("u0","u1",…) matched back to a measured height
  sectionTitle: string;
  isLead: boolean;
  html: string; // rendered at the chosen register; re-used verbatim in the measure doc AND the board
}

/** Expand the flowing sections into atomic units, numbering sections 1..N in reading order. */
function buildFlowUnits(
  secs: VocabSection[],
  register: string,
  vocab: ComponentVocabulary,
): FlowUnit[] {
  const units: FlowUnit[] = [];
  secs.forEach((sec, i) => {
    units.push({
      mk: `u${units.length}`,
      sectionTitle: sec.title,
      isLead: true,
      html: vocab.renderFlowLead({ number: i + 1, section: sec, register }),
    });
    for (const it of sec.items.slice(1)) {
      units.push({
        mk: `u${units.length}`,
        sectionTitle: sec.title,
        isLead: false,
        html: vocab.renderFlowRow({ item: it, register }),
      });
    }
  });
  return units;
}

/** Collect the inner text of every `<style>` block a set of HTML fragments emitted (hoist target). */
function collectStyles(htmls: string[]): string {
  const out: string[] = [];
  for (const h of htmls) {
    for (const m of h.matchAll(/<style>([\s\S]*?)<\/style>/g)) out.push(m[1] ?? "");
  }
  return out.join("");
}

/**
 * The off-screen MEASURE document (D72): every flow unit stacked in a single column of the EXACT
 * newspaper column width, at the chosen register, plus one sample continuation cue (`__cue__`). It goes
 * STRAIGHT to `BrowserPort.measure` (NOT the packager), so it is a full standalone document:
 *   - keep the DOCTYPE + head;
 *   - inline the SAME `--color-*` vars the board wrapper declares;
 *   - declare `@font-face`-FREE font-family fallbacks from `fontFamilies` — offline, none of the theme
 *     faces load, so every element falls back to a SYSTEM face. Heights only need the same
 *     font-size/line-height (carried verbatim in the reused unit HTML); the resulting ±2px face-metric
 *     error is absorbed by the balance slack (the accepted offline trade — D72; the prototype loaded
 *     Google Fonts, the engine must stay offline);
 *   - HOIST any `<style>` blocks the flow units emitted into the head so their rules apply while
 *     measuring (dhaba's flow pieces emit none; a theme with animated rows would).
 */
function buildMeasureDoc(
  columnWidth: number,
  units: FlowUnit[],
  register: string,
  vocab: ComponentVocabulary,
  colorTokens: Readonly<Record<string, string>>,
  fontFamilies: Readonly<Record<string, string>>,
): string {
  const fontStack = [
    ...Object.values(fontFamilies).map((f) => `'${f}'`),
    "system-ui",
    "sans-serif",
  ].join(",");
  const rows = units.map((u) => `<div data-mk="${u.mk}">${u.html}</div>`).join("");
  const sampleTitle = units.reduce(
    (a, u) => (u.sectionTitle.length > a.length ? u.sectionTitle : a),
    "Section",
  );
  const cue = `<div data-mk="__cue__">${vocab.renderContinuationCue({ sectionTitle: sampleTitle, register })}</div>`;
  const hoisted = collectStyles(units.map((u) => u.html));
  return (
    `<!DOCTYPE html><html><head>` +
    `<style>:root{${cssVars(colorTokens)}}*{box-sizing:border-box}body{margin:0}${hoisted}</style>` +
    `</head><body>` +
    `<div style="width:${columnWidth}px;font-family:${fontStack};color:var(--color-text)">` +
    rows +
    cue +
    `</div></body></html>`
  );
}

/** Assemble the shared banner + finalBlocks used by both the measured and CSS-fallback column paths. */
function columnsShared(
  blocks: CompositionBlock[],
  input: RenderComposedInput,
  sectionsByTitle: Map<string, VocabSection>,
  plan: LayoutPlan,
  warnings: string[],
): {
  f: FitResult;
  register: string;
  bannerHtml: string;
  flowSecs: VocabSection[];
  finalBlocks: CompositionBlock[];
} {
  const { vocab, photoMode, photoCandidates } = input;
  const flat = expandGroups(blocks);
  // Lift the first photoBand into a full-width banner above the columns.
  const bannerIdx = flat.findIndex((b) => b.kind === "photoBand");
  const banner: CompositionBlock | null = bannerIdx >= 0 ? flat[bannerIdx]! : null;
  const flow = bannerIdx >= 0 ? flat.filter((_, i) => i !== bannerIdx) : flat;

  const f = fit({ blocks: flow, sectionsByTitle, plan, vocab, banner });
  const register = f.register;
  const { bodyWidth } = f.layout;

  let bannerHtml = "";
  if (banner) {
    const cards = resolveCollage(banner.itemIds, photoCandidates, collageMax(photoMode), warnings);
    if (cards.length) {
      bannerHtml =
        `<div style="flex:none;margin-bottom:${BANNER_GAP}px">` +
        vocab.renderPhotoBand({
          items: cards,
          register,
          bandHeight: vocab.landscapeBannerHeight,
          bandWidth: bodyWidth,
          mode: photoMode,
          uid: "banner",
        }) +
        `</div>`;
    }
  }

  const flowSecs = flow
    .map((b) => (b.kind === "section" ? sectionsByTitle.get(b.section) : undefined))
    .filter((s): s is VocabSection => Boolean(s));
  const finalBlocks: CompositionBlock[] = [
    ...(banner ? [banner] : []),
    ...flowSecs.map((s) => sectionBlock(s.title)),
  ];
  return { f, register, bannerHtml, flowSecs, finalBlocks };
}

/**
 * Render the landscape flow body with EXPLICIT MEASURED COLUMNS (the default when a `measure` port is
 * available). Keep the register + column count the fitter chose, MEASURE every header/row at that
 * register + column width, then partition the units into balanced columns OURSELVES — so we know which
 * section leads each column and can stamp a "<Section> (cont.)" cue on any column that opens
 * mid-section. Falls back to the CSS `column-fill:balance` body (no cues) when no measurer is supplied.
 */
async function renderColumns(
  comp: CompositionResponse,
  blocks: CompositionBlock[],
  input: RenderComposedInput,
  sectionsByTitle: Map<string, VocabSection>,
  plan: LayoutPlan,
  measure: Measurer | undefined,
  warnings: string[],
): Promise<{
  html: string;
  f: FitResult;
  finalBlocks: CompositionBlock[];
  columnPlan?: ColumnPlan;
}> {
  const { vocab, colorTokens, fontFamilies } = input;
  const { f, register, bannerHtml, flowSecs, finalBlocks } = columnsShared(
    blocks,
    input,
    sectionsByTitle,
    plan,
    warnings,
  );
  const { columns, gap, columnWidth } = f.layout;
  const m = vocab.metrics(register);

  // ── CSS-balance fallback (no measurer): original behaviour, no continuation cues ──
  if (!measure) {
    const flowHtml = flowSecs
      .map((sec, i) => flowSection(i + 1, sec, register, i === flowSecs.length - 1, vocab))
      .join("");
    const body =
      `<div style="flex:1;min-height:0;column-count:${columns};column-gap:${gap}px;` +
      `column-rule:2px solid ${RULE};column-fill:balance;overflow:hidden">${flowHtml}</div>`;
    // The shell owns the body inset + the padded flex column; hand it the banner + column body directly.
    return { html: buildShell(comp, input, register, bannerHtml + body), f, finalBlocks };
  }

  // ── measured explicit columns ──
  const units = buildFlowUnits(flowSecs, register, vocab);
  const heights = await measure({
    html: buildMeasureDoc(columnWidth, units, register, vocab, colorTokens, fontFamilies),
    width: columnWidth,
  });
  const sizes: FlowUnitSize[] = units.map((u) => ({
    height: heights[u.mk] ?? (u.isLead ? m.flowLeadHeight() : m.flowRowHeight()), // safety net only
    isLead: u.isLead,
  }));
  const cueH = heights["__cue__"] ?? m.cueHeight();

  const groups = partitionColumns(sizes, columns, cueH, vocab.sectionGap);

  // Emit each column; stamp the cue when its first unit is a continuation row.
  const avail = f.contentHeight - f.bannerHeight;
  const cues: Array<{ column: number; section: string }> = [];
  const columnHeights: number[] = [];
  const columnHtml = groups.map((idxs, colIdx) => {
    const colUnits = idxs.map((k) => units[k]!);
    const first = colUnits[0];
    let cueHtml = "";
    if (first && !first.isLead) {
      cueHtml = vocab.renderContinuationCue({ sectionTitle: first.sectionTitle, register });
      cues.push({ column: colIdx + 1, section: first.sectionTitle });
    }
    let h = cueHtml ? cueH : 0;
    const innerCol = colUnits
      .map((u, idx) => {
        const gapTop = idx > 0 && u.isLead;
        h += sizes[idxs[idx]!]!.height + (gapTop ? vocab.sectionGap : 0);
        return `<div style="${gapTop ? `margin-top:${vocab.sectionGap}px` : ""}">${u.html}</div>`;
      })
      .join("");
    columnHeights.push(h);
    return `<div style="width:${columnWidth}px;flex:none">${cueHtml}${innerCol}</div>`;
  });

  // Explicit sibling columns with full-height vertical ink rules centred in each gutter (the same
  // newspaper divider the CSS `column-rule` drew).
  const rulePad = (gap - 2) / 2;
  const divider = `<div style="width:2px;flex:none;background:${RULE};margin:0 ${rulePad}px"></div>`;
  const body =
    `<div style="flex:1;min-height:0;display:flex;align-items:stretch;overflow:hidden">` +
    columnHtml.join(divider) +
    `</div>`;
  // The shell owns the body inset + the padded flex column; hand it the banner + column body directly.
  const inner = bannerHtml + body;

  const tallest = Math.max(...columnHeights);
  const overflow = tallest > avail + 1;
  if (overflow) {
    warnings.push(
      `columns overflow: tallest column ${tallest.toFixed(0)}px > available ${avail.toFixed(0)}px at register ${register}`,
    );
  }
  const columnPlan: ColumnPlan = {
    columns,
    register,
    columnHeights: columnHeights.map((x) => Math.round(x)),
    avail: Math.round(avail),
    balanceDelta: Math.round(tallest - Math.min(...columnHeights)),
    overflow,
    cues,
  };
  return { html: buildShell(comp, input, register, inner), f, finalBlocks, columnPlan };
}

export async function renderComposed(input: RenderComposedInput): Promise<RenderComposedResult> {
  const { composition: comp, sections, vocab } = input;
  const warnings: string[] = [];
  const sectionsByTitle = new Map(sections.map((s) => [s.title, s]));

  const blocks = normalizeBlocks(comp.blocks, sectionsByTitle, warnings);

  // COVERAGE GUARANTEE: append any section the LLM forgot as its own full-width block.
  const covered = coveredTitles(blocks);
  const missing = sections.filter((s) => !covered.has(s.title));
  if (missing.length > 0) {
    warnings.push(
      `coverage: appended ${missing.length} forgotten section(s): ${missing.map((s) => s.title).join(", ")}`,
    );
    for (const s of missing) blocks.push(sectionBlock(s.title));
  }

  // SLOT-COVERAGE GUARANTEE (band): a comfortable board's per-section image slots live in the shared
  // photo band (each card stamps data-image-slot="<slot>"). If the composer emitted NO photoBand at all,
  // those planned slots would render no marker → checkImageSlots majors. Append ONE empty-picks photoBand
  // (resolveCollage then supplies ≥1 card per distinct slot) so every per-section slot is representable.
  // Fires only when the plan carries per-section slots (defined-slot candidates) and the composer forgot
  // the band — mirrors the section coverage guarantee above; board-level-only boards are untouched.
  const hasPhotoBand = blocks.some((b) => b.kind === "photoBand");
  const hasSlottedPhotos = input.photoCandidates.some((c) => c.slot !== undefined);
  if (!hasPhotoBand && hasSlottedPhotos) {
    warnings.push(
      "slot-coverage: composer emitted no photoBand; appended one for the board's per-section image slots.",
    );
    blocks.unshift(photoBandBlock([]));
  }

  const plan = planLayout(input.canvas, vocab);
  if (plan.mode === "columns") {
    const rendered = await renderColumns(
      comp,
      blocks,
      input,
      sectionsByTitle,
      plan,
      input.measure,
      warnings,
    );
    return {
      html: rendered.html,
      finalBlocks: rendered.finalBlocks,
      fit: rendered.f,
      warnings,
      ...(rendered.columnPlan ? { columnPlan: rendered.columnPlan } : {}),
    };
  }
  const rendered = renderStack(comp, blocks, input, sectionsByTitle, plan, warnings);
  return {
    html: rendered.html,
    finalBlocks: rendered.finalBlocks,
    fit: rendered.f,
    warnings,
  };
}
