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
  columnWidthFor,
  COLUMNS_BOTTOM_SAFETY,
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
  /**
   * The theme's embedded font faces (offline `data:` URIs). Inlined as `@font-face` into the landscape
   * MEASURE document so the offline measure renders with the REAL theme faces — headers/rows then wrap
   * exactly as the poster does, and the measured column partition matches the render (closing the D72
   * offline-vs-real gap at its source, not just absorbing it in slack). Optional / defaults to none: a
   * theme with no embedded faces measures against system fallbacks as before.
   */
  fontFaces?: ReadonlyArray<{ family: string; dataUri: string; weight?: string | undefined }>;
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

/**
 * SPARSE-BOARD PHOTO GROWTH (user-approved 2026-07-13): when the fitted board leaves slack, the
 * photo band absorbs a capped share of it — "few dishes, big appetizing photos" instead of a small
 * strip floating in air. Growth is a COMPUTED pixel bonus (never CSS flex): themes derive card
 * width from the band height at a fixed per-register ratio and photos are `object-fit:cover`, so
 * scaled cards keep their aspect. The share (not all) of the slack keeps a margin for the fit's
 * estimate error, and the multiple cap keeps photos from dominating a near-empty board; the QA
 * overflow check remains the backstop.
 */
const BAND_GROWTH_SHARE = 0.65;
const BAND_GROWTH_MAX = 0.8; // bonus ≤ 0.8 × base height (band ≤ 1.8× base)

function bandGrowthBonus(slack: number, baseHeight: number, bands: number): number {
  if (bands <= 0 || slack <= 0) return 0;
  return Math.floor(Math.min((slack * BAND_GROWTH_SHARE) / bands, baseHeight * BAND_GROWTH_MAX));
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

/**
 * The base (root) line-height the composed board inherits once packaged. The packager compiles
 * Tailwind, whose preflight sets a unitless `line-height:1.5` on the root; price rows declare a
 * font-size but no line-height, so they inherit it. The off-screen MEASURE document replicates this so
 * measured row heights equal the shipped render (engine-generic: a property of the packaged output).
 *
 * Exported so a hermetic regression pin (`src/adapters/tailwind/packager.test.ts`) can assert the REAL
 * packaged Preflight base line-height still equals this value — the measured-overflow guard only catches
 * OVER-measurement, so if this constant ever drifts BELOW the packaged base (e.g. a Tailwind upgrade
 * changing Preflight) the measure would silently UNDER-measure and landscape columns would clip (the
 * D77 bug) with no other test to catch it.
 */
export const PACKAGED_BASE_LINE_HEIGHT = 1.5;

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
 * Resolve a photoBand block's ids into real photo items (photo-truth, D72: keys on `hasImage`). The band
 * width can only hold so many cards before the fixed frame crops them, so `capacity` — theme-derived
 * (`vocab.photoBandCapacity` ∧ the mode's carousel cap) — bounds the FILLER the band adds. Ordering
 * (mirrors this file's section coverage guarantee + coverage.ts: the LLM judges, code guarantees the
 * bookkeeping):
 *
 *   1. SLOT-COVERAGE GUARANTEE first — ≥1 card per DISTINCT per-section slot. This is a HARD guarantee,
 *      NOT bounded by `capacity`: `checkImageSlots` requires a marker per planned photo slot, so a slot is
 *      never dropped for width (that would just trade a crop for an `image-slot-missing` major). When the
 *      distinct slots exceed the width capacity the band simply packs tighter — a comfortable board is a
 *      handful of slots — and we warn so the over-packing is visible (mirrors the pre-cap over-capacity
 *      warning). Doing this before the composer's picks keeps filler from starving a slot.
 *   2. the composer's explicit picks — judgment (known id + hasImage, de-duplicated, in order), filling
 *      the REMAINING width capacity only (filler never pushes the band past the width fit; the guaranteed
 *      slot cards above may already meet or exceed it).
 *   3. generic padding to ≥3 (clamped to capacity) from any remaining candidates.
 *
 * Board-level items carry no slot (step 1 is a no-op; the band root's `data-image-slot="shared"` satisfies
 * them) — so for a board-level-only band the order collapses to composer-picks-then-pad bounded by the
 * width capacity: exactly the crop fix (the live run's runaway 7–8 filler cards → the width's ~3).
 */
function resolveCollage(
  ids: string[],
  photoCandidates: VocabItem[],
  capacity: number,
  warnings: string[],
): VocabItem[] {
  const byId = new Map(photoCandidates.map((c) => [c.id, c]));
  const picked: VocabItem[] = [];
  const seen = new Set<string>();
  const take = (c: VocabItem): void => {
    picked.push(c);
    seen.add(c.id);
  };
  // 1. Slot-coverage guarantee FIRST — ≥1 card per distinct per-section slot; a HARD guarantee, never
  //    dropped for width (dropping one would reintroduce an image-slot-missing major). Warn when the
  //    slots exceed the width capacity so the tighter packing is surfaced.
  const distinctSlots = [
    ...new Set(photoCandidates.map((c) => c.slot).filter((s): s is string => s !== undefined)),
  ];
  if (distinctSlots.length > capacity) {
    warnings.push(
      `photo band: ${distinctSlots.length} image slots exceed the ${capacity}-card width capacity — ` +
        `packing the band tighter to keep every slot represented.`,
    );
  }
  for (const slot of distinctSlots) {
    const card = photoCandidates.find((c) => c.slot === slot && c.hasImage && !seen.has(c.id));
    if (card !== undefined) take(card); // the slot's photos may all already be picked → skip
  }
  // 2. The composer's explicit picks — judgment (known id + hasImage, de-duplicated, in order), filling
  //    the remaining width capacity (never past it).
  for (const id of ids) {
    if (picked.length >= capacity) break;
    const it = byId.get(id);
    if (it && it.hasImage && !seen.has(id)) take(it);
  }
  // 3. Pad to at least 3 (never past capacity) from any remaining candidates (generic padding).
  const padTo = Math.min(3, capacity);
  for (const c of photoCandidates) {
    if (picked.length >= padTo) break;
    if (!seen.has(c.id) && c.hasImage) take(c);
  }
  return picked;
}

/** The band's card capacity: the mode's carousel cap ∧ the width the band actually accommodates
 * (theme-derived — {@link ComponentVocabulary.photoBandCapacity}). */
function bandCapacity(mode: PhotoBandMode, bandWidth: number, vocab: ComponentVocabulary): number {
  return Math.min(collageMax(mode), vocab.photoBandCapacity(bandWidth));
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
  bandBonus = 0,
): { html: string; endNumber: number } {
  const { vocab, photoMode, photoCandidates } = input;
  const m = vocab.metrics(register);
  let n = startNumber;
  const parts = list.map((b, i) => {
    if (b.kind === "photoBand") {
      const capacity = bandCapacity(photoMode, bandWidth, vocab);
      const cards = resolveCollage(b.itemIds, photoCandidates, capacity, warnings);
      if (cards.length === 0) return "";
      return vocab.renderPhotoBand({
        items: cards,
        register,
        bandHeight: m.photoBandHeight() + bandBonus,
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
  // Sparse-board growth: the band(s) absorb a capped share of the estimated leftover height.
  const bandBonus = bandGrowthBonus(
    plan.bodyHeight - f.usedHeight,
    input.vocab.metrics(f.register).photoBandHeight(),
    blocks.filter((b) => b.kind === "photoBand").length,
  );
  const { html: body } = renderBlockList(
    blocks,
    0,
    f.register,
    input,
    sectionsByTitle,
    f.layout.columnWidth,
    f.layout.maxInternalCols,
    warnings,
    bandBonus,
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

/**
 * Measured content height of ONE landscape column: its units' measured heights + the section gap
 * before every lead EXCEPT the one at the column top + a continuation-cue line when the column opens
 * mid-section. The single source of truth shared by the emit (which stamps the same markup) and the
 * measured-overflow guard (which compares it — plus a per-row font-drift budget — against the body).
 */
function measuredColumnHeight(
  idxs: number[],
  units: FlowUnit[],
  sizes: FlowUnitSize[],
  cueH: number,
  sectionGap: number,
): number {
  const hasCue = idxs.length > 0 && !units[idxs[0]!]!.isLead;
  let h = hasCue ? cueH : 0;
  idxs.forEach((k, idx) => {
    h += sizes[k]!.height + (idx > 0 && units[k]!.isLead ? sectionGap : 0);
  });
  return h;
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
 *   - inline the theme's `@font-face` faces from `fontFaces` (offline `data:` URIs, the same faces the
 *     packager embeds) so the measure renders with the REAL theme fonts — `measure` awaits
 *     `document.fonts.ready`, so headers/rows WRAP exactly as the poster does and the measured column
 *     partition matches the render. This closes the D72 offline-vs-real gap at its source (a decorative
 *     display face like Shrikhand wraps a header very differently from a serif fallback — a whole-line
 *     error the ±2px "balance slack" never covered). A theme with no embedded faces measures against the
 *     `system-ui` fallback as before;
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
  fontFaces: ReadonlyArray<{ family: string; dataUri: string; weight?: string | undefined }>,
): string {
  // The measure wrapper's default font = the theme's BODY stack (rows inherit it; headers set their own
  // family). The fontFamilies values are already valid CSS font stacks (e.g. "'Archivo', system-ui,
  // sans-serif") — used VERBATIM: quoting the whole stack again yields malformed CSS and silently drops
  // rows to a system fallback, mis-measuring every row (the offline-measure clip bug). With the theme's
  // @font-face above now loaded, the real body face resolves and rows measure at their true height.
  const fontStack =
    fontFamilies["body"] ?? Object.values(fontFamilies)[0] ?? "system-ui, sans-serif";
  // Same @font-face shape the packager emits — real theme faces so offline wrapping matches the poster.
  const fontFaceCss = fontFaces
    .map(
      (f) =>
        `@font-face{font-family:'${f.family}';font-weight:${f.weight ?? "normal"};` +
        `src:url(${f.dataUri}) format('woff2');font-display:swap;}`,
    )
    .join("");
  const rows = units.map((u) => `<div data-mk="${u.mk}">${u.html}</div>`).join("");
  const sampleTitle = units.reduce(
    (a, u) => (u.sectionTitle.length > a.length ? u.sectionTitle : a),
    "Section",
  );
  // `display:flow-root` establishes a BFC so the cue's OWN bottom margin (e.g. the header rhythm the
  // theme puts under it) is CONTAINED in the measured box — getBoundingClientRect otherwise excludes
  // margins, but in the rendered board the cue lives in a flex column (also a BFC) where that margin
  // DOES push the units below it down. Without this a continuation column is under-measured by the cue
  // margin (~a header's worth), which is exactly enough to let a near-full column clip past the frame.
  const cue = `<div data-mk="__cue__" style="display:flow-root">${vocab.renderContinuationCue({ sectionTitle: sampleTitle, register })}</div>`;
  const hoisted = collectStyles(units.map((u) => u.html));
  // The shipped board is packaged through Tailwind, whose preflight sets a unitless `line-height:1.5`
  // on the root that every price row inherits (rows declare a font-size but no line-height). The measure
  // MUST render in that same base or rows measure at the UA `normal` (~1.2) — ~9px short each, ~a
  // hundred px over a full column — and a genuinely overflowing board looks like it fits. Headers/cues
  // set their own line-height inline and are unaffected. Mirrors PACKAGED_BASE_LINE_HEIGHT.
  return (
    `<!DOCTYPE html><html><head>` +
    `<style>${fontFaceCss}:root{${cssVars(colorTokens)}}*{box-sizing:border-box}` +
    `body{margin:0;line-height:${PACKAGED_BASE_LINE_HEIGHT}}${hoisted}</style>` +
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
  /** Render the full-width banner at a given register — called ONCE, at whatever register the measured
   *  re-fit settles on (its height is register-independent, so avail is unaffected). */
  renderBanner: (register: string) => string;
  flowSecs: VocabSection[];
  finalBlocks: CompositionBlock[];
  /** Sparse-board growth added to the banner height (px) — callers must subtract it from `avail`. */
  bannerBonus: number;
} {
  const { vocab, photoMode, photoCandidates } = input;
  const flat = expandGroups(blocks);
  // Lift the first photoBand into a full-width banner above the columns.
  const bannerIdx = flat.findIndex((b) => b.kind === "photoBand");
  const banner: CompositionBlock | null = bannerIdx >= 0 ? flat[bannerIdx]! : null;
  const flow = bannerIdx >= 0 ? flat.filter((_, i) => i !== bannerIdx) : flat;

  const f = fit({ blocks: flow, sectionsByTitle, plan, vocab, banner });
  const { bodyWidth } = f.layout;

  // Sparse-board growth: the banner absorbs a capped share of the estimated leftover height. The
  // bonus is decided ONCE, from the initial fit's estimate, BEFORE the measured pass — the guard
  // then balances columns against the reduced space, so growth can never introduce clipping.
  const bannerBonus = banner
    ? bandGrowthBonus(plan.bodyHeight - f.usedHeight, vocab.landscapeBannerHeight, 1)
    : 0;

  // Resolve the band's cards ONCE (resolveCollage pushes warnings; a second call would duplicate them),
  // then render at whatever register the caller finally picks — the band's height is fixed
  // (landscapeBannerHeight), so its register only affects card geometry, never avail.
  const bannerCards = banner
    ? resolveCollage(
        banner.itemIds,
        photoCandidates,
        bandCapacity(photoMode, bodyWidth, vocab),
        warnings,
      )
    : [];
  const renderBanner = (register: string): string => {
    if (!banner || bannerCards.length === 0) return "";
    return (
      `<div style="flex:none;margin-bottom:${BANNER_GAP}px">` +
      vocab.renderPhotoBand({
        items: bannerCards,
        register,
        bandHeight: vocab.landscapeBannerHeight + bannerBonus,
        bandWidth: bodyWidth,
        mode: photoMode,
        uid: "banner",
      }) +
      `</div>`
    );
  };

  const flowSecs = flow
    .map((b) => (b.kind === "section" ? sectionsByTitle.get(b.section) : undefined))
    .filter((s): s is VocabSection => Boolean(s));
  const finalBlocks: CompositionBlock[] = [
    ...(banner ? [banner] : []),
    ...flowSecs.map((s) => sectionBlock(s.title)),
  ];
  return { f, renderBanner, flowSecs, finalBlocks, bannerBonus };
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
  const fontFaces = input.fontFaces ?? [];
  const { f, renderBanner, flowSecs, finalBlocks, bannerBonus } = columnsShared(
    blocks,
    input,
    sectionsByTitle,
    plan,
    warnings,
  );
  const { gap } = f.layout;
  // Body height available to the columns — bodyHeight minus the (register-independent) banner,
  // including any sparse-board growth the banner absorbed.
  const avail = f.contentHeight - f.bannerHeight - bannerBonus;

  // ── CSS-balance fallback (no measurer): original behaviour, no continuation cues ──
  if (!measure) {
    const register = f.register;
    const { columns } = f.layout;
    const flowHtml = flowSecs
      .map((sec, i) => flowSection(i + 1, sec, register, i === flowSecs.length - 1, vocab))
      .join("");
    const body =
      `<div style="flex:1;min-height:0;column-count:${columns};column-gap:${gap}px;` +
      `column-rule:2px solid ${RULE};column-fill:balance;overflow:hidden">${flowHtml}</div>`;
    // The shell owns the body inset + the padded flex column; hand it the banner + column body directly.
    return {
      html: buildShell(comp, input, register, renderBanner(register) + body),
      f,
      finalBlocks,
    };
  }

  // ── measured explicit columns, with a deterministic MEASURED-OVERFLOW GUARD ──
  // `fit` chose (columns, register) on ESTIMATES; the real partition here runs over MEASURED pixels —
  // now measured with the REAL theme faces (buildMeasureDoc inlines them), so the partition matches the
  // poster's wrapping. Measure one candidate: partition its units into balanced columns and report the
  // tallest column's measured height. A candidate "fits" only when the tallest column clears the body
  // minus a small bottom safety, so its last row can't slip under the bottom frame.
  interface Candidate {
    columns: number;
    register: string;
    columnWidth: number;
    units: FlowUnit[];
    sizes: FlowUnitSize[];
    cueH: number;
    groups: number[][];
    tallest: number; // measured height of the tallest balanced column
  }
  const planColumns = async (columns: number, register: string): Promise<Candidate> => {
    const columnWidth = columnWidthFor(plan.bodyWidth, columns);
    const m = vocab.metrics(register);
    const units = buildFlowUnits(flowSecs, register, vocab);
    const heights = await measure({
      html: buildMeasureDoc(
        columnWidth,
        units,
        register,
        vocab,
        colorTokens,
        fontFamilies,
        fontFaces,
      ),
      width: columnWidth,
    });
    const sizes: FlowUnitSize[] = units.map((u) => ({
      height: heights[u.mk] ?? (u.isLead ? m.flowLeadHeight() : m.flowRowHeight()), // safety net only
      isLead: u.isLead,
    }));
    const cueH = heights["__cue__"] ?? m.cueHeight();
    const groups = partitionColumns(sizes, columns, cueH, vocab.sectionGap);
    const tallest = Math.max(
      ...groups.map((idxs) => measuredColumnHeight(idxs, units, sizes, cueH, vocab.sectionGap)),
    );
    return { columns, register, columnWidth, units, sizes, cueH, groups, tallest };
  };

  // The next STRONGER (shorter-column) candidate: add a column first — preserving the type size, which
  // mirrors `fit`'s largest-register bias — as long as the plan allows another legible column; otherwise
  // demote the register one step at the same column count. `null` = search exhausted (ship the densest).
  const strongerLayout = (
    columns: number,
    register: string,
  ): { columns: number; register: string } | null => {
    if (
      columns + 1 <= plan.maxColumns &&
      columnWidthFor(plan.bodyWidth, columns + 1) >= vocab.minStreamWidth
    ) {
      return { columns: columns + 1, register };
    }
    const i = vocab.registerNames.indexOf(register);
    if (i >= 0 && i + 1 < vocab.registerNames.length) {
      return { columns, register: vocab.registerNames[i + 1]! };
    }
    return null;
  };

  const overflows = (c: Candidate): boolean => c.tallest > avail - COLUMNS_BOTTOM_SAFETY;
  let candidate = await planColumns(f.layout.columns, f.register);
  while (overflows(candidate)) {
    const next = strongerLayout(candidate.columns, candidate.register);
    if (!next) break; // exhausted — keep the densest attempt; the overflow warning stays honest below
    candidate = await planColumns(next.columns, next.register);
  }

  const { columns, register, columnWidth, units, sizes, cueH, groups } = candidate;

  // Emit each column; stamp the cue when its first unit is a continuation row.
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
    const innerCol = colUnits
      .map((u, idx) => {
        const gapTop = idx > 0 && u.isLead;
        return `<div style="${gapTop ? `margin-top:${vocab.sectionGap}px` : ""}">${u.html}</div>`;
      })
      .join("");
    columnHeights.push(measuredColumnHeight(idxs, units, sizes, cueH, vocab.sectionGap));
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
  // The banner renders at the register the guard settled on so its cards match the columns.
  const inner = renderBanner(register) + body;

  const tallest = Math.max(...columnHeights);
  const overflow = tallest > avail + 1;
  if (overflow) {
    warnings.push(
      `columns overflow: tallest column ${tallest.toFixed(0)}px > available ${avail.toFixed(0)}px at register ${register} (${columns} cols) — re-fit exhausted`,
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
