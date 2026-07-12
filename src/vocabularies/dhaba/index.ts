/**
 * The `dhaba` component vocabulary (D71) — the first real {@link ComponentVocabulary}.
 *
 * Five hand-designed components mined from the gold board
 * `reference-boards/3b-dhaba-poster-street-sweets.dc.html`, ported from the validated prototype
 * `prototypes/component-vocab/catalog.ts` into ENGINE-LEGAL output:
 *
 *   1. shell (masthead + truck-art stripe frame) — one `data-composed="dhaba@1"` root, no document
 *      chrome, tokens referenced as `var(--color-*)` only (the packager declares them + owns fonts).
 *   2. section  — teal numbered chip + Shrikhand chilli title + ink rule, dotted-leader price rows.
 *   3. group    — 2–3 SMALL sections side by side, divided by vertical ink rules (the prototype's triBand).
 *   4. photoBand — tilted white polaroid cards with captions in three modes: `static` (overlap pile),
 *      `crossfade` (stacked deck), `filmstrip` (scrolling marquee). Both carousels ship a
 *      reduced-motion settled frame so the QA browser screenshots a representative (non-empty) state.
 *   5. continuation cue — the subtle "<Section> (cont.)" marker at a spilled landscape column top.
 *
 * Every render is PURE (no IO/clock/randomness). Images are src-less `<img data-img-item>` placeholders
 * the packager inlines; every price row is stamped `data-item-id` + `data-bind="price"`; the photo band
 * root carries `data-image-slot="shared"`. The four literal `rgba(42,26,14,…)` / `rgba(242,181,58,…)`
 * inks are alpha composites of theme inks with no token form (composed HTML is token-lint-exempt).
 */

import type { BrandInput } from "../../domain/types";
import type {
  ComponentVocabulary,
  ShellArgs,
  VocabCanvas,
  VocabItem,
  VocabSection,
  VocabularyMetrics,
} from "../../ports/vocabulary-registry";

// ── Canvas geometry of the de-runtimed shell (px), measured from the gold board ─────────────────────
//   1080×1920 − 16px stripe frame each side → 1048×1888 paper.
//   header 96px; content column padding 24px top / 30px bottom, 36px sides.
const FRAME = 16;
const HEADER = 96;
const PAD_TOP = 24;
const PAD_BOTTOM = 30;
const PAD_SIDE = 36;

const LINE = 1.25; // line-height factor for row-height estimates

/** The dotted-leader / thin-divider ink colour — theme `text` at 0.35/0.2 alpha (gold board value).
 * Alpha composites of a theme ink with no token form; composed HTML is token-lint-exempt. */
const LEADER = "rgba(42,26,14,0.35)";
const DIVIDER = "rgba(42,26,14,0.2)";

// ── Registers (px) — verbatim from the prototype fitter's REGISTERS table ────────────────────────────
type RegisterName = "L" | "M" | "S";

/** One size register (px). The layout engine picks L/M/S for the whole board; templates read these. */
interface Register {
  name: RegisterName;
  // full-width section header
  chip: number;
  chipFont: number;
  sectionTitle: number;
  headerMb: number;
  // full-width rows
  rowName: number;
  rowPad: number;
  colGap: number;
  // group (small) variants
  smChip: number;
  smChipFont: number;
  smSectionTitle: number;
  smRowName: number;
  smRowPad: number;
  smHeaderMb: number;
  // polaroid card
  cardW: number;
  cardPhotoH: number;
  captionFont: number;
}

const REGISTERS: Record<RegisterName, Register> = {
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

/** Resolve a register name (the layout engine passes names only) to its px table; falls back to M. */
function registerByName(name: string): Register {
  return REGISTERS[name as RegisterName] ?? REGISTERS.M;
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────
const money = (p: number | null): string => (p === null ? "" : `$${p.toFixed(2)}`);
const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── metric helpers (px height estimates the layout engine fits on) ───────────────────────────────────
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
function collageBandHeight(r: Register): number {
  return r.cardPhotoH + r.captionFont * LINE + 22 + 34; // photo + caption + card padding + tilt slack
}

// ── 2. sectionHeader ───────────────────────────────────────────────────────────────────────────────
function sectionHeader(n: number, title: string, r: Register, small = false): string {
  const chip = small ? r.smChip : r.chip;
  const chipFont = small ? r.smChipFont : r.chipFont;
  const titleSize = small ? r.smSectionTitle : r.sectionTitle;
  const mb = small ? r.smHeaderMb : r.headerMb;
  const chipNudge = small ? 4 : 5;
  const ruleNudge = small ? -7 : -8;
  return (
    `<div style="display:flex;align-items:baseline;gap:${small ? 10 : 12}px;margin-bottom:${mb}px">` +
    `<span style="display:inline-flex;align-items:center;justify-content:center;width:${chip}px;height:${chip}px;` +
    `background:var(--color-chip);color:var(--color-bg);border-radius:999px;font-size:${chipFont}px;font-weight:800;` +
    `transform:translateY(${chipNudge}px)">${n}</span>` +
    `<span style="font-family:'Shrikhand',serif;font-size:${titleSize}px;color:var(--color-accent);line-height:1.05">${esc(title)}</span>` +
    `<span style="flex:1;border-bottom:2px solid var(--color-text);transform:translateY(${ruleNudge}px)"></span>` +
    `</div>`
  );
}

/**
 * Continuation cue — a SUBTLE marker stamped at the top of a landscape column that opens mid-section
 * (its section's numbered header lives in an earlier column). Deliberately subordinate to the real
 * numbered header: italic Shrikhand in the MUTED ink (never the bright accent red), no number chip,
 * smaller type, and a thin muted rule (vs the header's 2px ink rule). Text: "<Section> (cont.)".
 */
function continuationCue(title: string, r: Register): string {
  const size = Math.max(16, Math.round(r.sectionTitle * 0.66));
  return (
    `<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:${r.headerMb}px">` +
    `<span style="font-family:'Shrikhand',serif;font-style:italic;font-size:${size}px;color:var(--color-muted);` +
    `line-height:1.1">${esc(title)} (cont.)</span>` +
    `<span style="flex:1;border-bottom:1px solid ${DIVIDER};transform:translateY(-5px)"></span>` +
    `</div>`
  );
}

// ── 3. priceList ──────────────────────────────────────────────────────────────────────────────────
/**
 * One item row (name → dotted leader → price). Stamps the binding contract the engine's QA enforces:
 * `data-item-id` on the row root (binding-integrity) and `data-bind="price"` on the price span
 * (a non-whitespace price text is what the price-present check treats as "filled"). Exported so the
 * landscape flow can place rows itself.
 */
function priceRow(item: VocabItem, r: Register, small: boolean): string {
  const nameSize = small ? r.smRowName : r.rowName;
  const pad = small ? r.smRowPad : r.rowPad;
  const priceHtml =
    item.price === null
      ? `<span data-bind="price" style="font-size:${Math.round(nameSize * 0.7)}px;font-weight:800;color:var(--color-price);border:2px solid var(--color-price);padding:0 6px">MP</span>`
      : `<span data-bind="price" style="font-size:${nameSize}px;font-weight:800;color:var(--color-price);font-variant-numeric:tabular-nums">${money(item.price)}</span>`;
  return (
    `<div data-item-id="${item.id}" style="display:flex;align-items:baseline;gap:10px;padding:${pad}px 0">` +
    `<span style="font-size:${nameSize}px;font-weight:600">${esc(item.name)}</span>` +
    `<span style="flex:1;border-bottom:2px dotted ${LEADER};transform:translateY(-4px)"></span>` +
    priceHtml +
    `</div>`
  );
}

/** priceList — item rows flowing top-to-bottom then across `columns` (1/2/3), like the gold grid. */
function priceList(items: VocabItem[], columns: number, r: Register, small = false): string {
  const cols = Math.max(1, Math.min(3, columns));
  const rows = Math.ceil(items.length / cols);
  const cells = items.map((it) => priceRow(it, r, small)).join("");
  const gap = small ? 24 : r.colGap;
  return (
    `<div style="display:grid;grid-auto-flow:column;grid-template-rows:repeat(${rows},auto);` +
    `grid-template-columns:repeat(${cols},1fr);column-gap:${gap}px">${cells}</div>`
  );
}

// ── 5. triBand (group) ──────────────────────────────────────────────────────────────────────────────
function triBand(sections: VocabSection[], startNumber: number, r: Register): string {
  const n = sections.length;
  // Widen the last column slightly when 3-across, mirroring gold (1fr 1fr 1.15fr).
  const template = n === 3 ? "1fr 1fr 1.15fr" : Array(n).fill("1fr").join(" ");
  const cols = sections
    .map((sec, i) => {
      const first = i === 0;
      const pad = first ? "padding-right:24px" : "padding:0 24px";
      const border = first ? "" : `border-left:2px solid ${DIVIDER};`;
      const padStyle = i === n - 1 && !first ? "padding-left:24px" : pad;
      return (
        `<div style="${border}${padStyle}">` +
        sectionHeader(startNumber + i, sec.title, r, true) +
        priceList(sec.items, 1, r, true) +
        `</div>`
      );
    })
    .join("");
  return `<div style="display:grid;grid-template-columns:${template}">${cols}</div>`;
}

// ── 4. polaroid photo band ──────────────────────────────────────────────────────────────────────────
const TILTS = [-2, 1.5, -1, 2.5, -1.5, 1, -2.5, 2, -1.5, 1.5];
const CARD_PAD_TOP = 10; // white polaroid margin above the photo (px)

/** Caption band height (text + its 10/12 vertical padding) for a given caption font size. */
function captionBandH(capFont: number): number {
  return Math.round(capFont * 1.25) + 22;
}

/**
 * One white polaroid: tape accent + photo + caption, tilted by `tilt`. The image and caption live in
 * the SAME element, so whatever a carousel does to this card (fade it, slide it), photo + caption move
 * together — the caption can never show over a different dish's photo. The `<img>` is a SRC-LESS
 * placeholder (`data-img-item`/`data-img-index`) the packager inlines to an offline data-URI.
 */
function polaroidCard(
  c: VocabItem,
  w: number,
  photoH: number,
  capFont: number,
  tilt: number,
): string {
  return (
    `<div style="width:${w}px;background:var(--color-surface);padding:${CARD_PAD_TOP}px 10px 0;` +
    `box-shadow:0 10px 24px rgba(42,26,14,0.28);transform:rotate(${tilt}deg);position:relative">` +
    `<div style="position:absolute;top:-9px;left:50%;transform:translateX(-50%) rotate(${-tilt}deg);` +
    `width:64px;height:20px;background:rgba(242,181,58,0.55);box-shadow:0 1px 2px rgba(42,26,14,0.2)"></div>` +
    `<div style="height:${photoH}px;position:relative;overflow:hidden">` +
    `<img data-img-item="${c.id}" data-img-index="0" alt="${esc(c.name)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></div>` +
    `<div style="text-align:center;font-size:${capFont}px;font-weight:700;padding:10px 6px 12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(c.name)}</div>` +
    `</div>`
  );
}

/** Photo height that makes a polaroid (with caption + padding + tilt slack) fill exactly `bandHeight`. */
function fitPhotoH(bandHeight: number, capFont: number): number {
  const tiltSlack = 16;
  return Math.max(120, bandHeight - tiltSlack - CARD_PAD_TOP - captionBandH(capFont));
}

/**
 * CROSS-FADE DECK (pure CSS). N polaroids absolutely stacked in a fixed-height band; each is visible
 * for `dwell`s then cross-fades to the next, looping through ALL N forever. Each layer runs the SAME
 * keyframes over the full `cycle = N*dwell`, staggered by `animation-delay`, with `backwards` fill so a
 * layer is invisible (opacity 0) until its slot.
 *
 * Reduced-motion settled state (QA screenshot correctness): the QA browser renders with
 * `reducedMotion:"reduce"` and leaves infinite animations running — but a paused/unhandled deck
 * screenshots EMPTY, because every layer's inline `opacity:0` is its resting state. The
 * `@media (prefers-reduced-motion:reduce)` block suspends the loop (`animation:none`) and forces the
 * FIRST layer visible (`opacity:1`) — a representative, non-empty frame. `!important` is required to
 * beat the elements' inline `animation`/`opacity`. The TV never sets reduced-motion, so live boards
 * still animate — same bytes, honest QA frame.
 */
function crossfadeDeck(cards: VocabItem[], r: Register, bandHeight: number, uid: string): string {
  const n = cards.length;
  const dwell = 3.5; // seconds each photo is held on screen
  const fade = 0.7; // cross-dissolve seconds
  const cycle = +(n * dwell).toFixed(2);
  const slotPct = 100 / n;
  const fadePct = (fade / cycle) * 100;
  const anim = `xfade_${uid}`;
  const capFont = r.captionFont;
  const photoH = fitPhotoH(bandHeight, capFont);
  const w = Math.round(photoH * (r.cardW / r.cardPhotoH));
  const keyframes =
    `@keyframes ${anim}{` +
    `0%{opacity:0}` +
    `${fadePct.toFixed(3)}%{opacity:1}` +
    `${slotPct.toFixed(3)}%{opacity:1}` +
    `${(slotPct + fadePct).toFixed(3)}%{opacity:0}` +
    `100%{opacity:0}}`;
  const settled =
    `@media (prefers-reduced-motion:reduce){` +
    `[data-anim="${anim}"]{animation:none!important}` +
    `[data-anim="${anim}"][data-xf-first]{opacity:1!important}}`;
  const layers = cards
    .map((c, i) => {
      const tilt = TILTS[i % TILTS.length] ?? 0;
      const delay = (i * dwell).toFixed(2);
      const firstAttr = i === 0 ? " data-xf-first" : "";
      return (
        `<div data-anim="${anim}"${firstAttr} style="position:absolute;inset:0;display:flex;justify-content:center;align-items:center;` +
        `opacity:0;animation:${anim} ${cycle}s linear ${delay}s infinite backwards">` +
        polaroidCard(c, w, photoH, capFont, tilt) +
        `</div>`
      );
    })
    .join("");
  return (
    `<div data-image-slot="shared" style="height:${bandHeight}px;flex:none;position:relative;overflow:hidden">` +
    `<style>${keyframes}${settled}</style>${layers}</div>`
  );
}

/**
 * SLIDING FILMSTRIP / marquee (pure CSS). A row of spaced, tilted polaroids scrolling left forever; the
 * track holds TWO identical copies of the N cards and `translateX(0 → -50%)` linear-infinite moves it by
 * exactly one copy's width for a seamless wrap. Each card carries its own caption, so image + caption
 * travel as one unit.
 *
 * Reduced-motion settled state: the `@media (prefers-reduced-motion:reduce)` block sets
 * `animation:none` on the track, which reverts it to `translateX(0)` — the first cards visible — so the
 * QA screenshot is a representative frame rather than a mid-scroll (or blank) one.
 */
function filmstrip(cards: VocabItem[], r: Register, bandHeight: number, uid: string): string {
  const n = cards.length;
  const perCard = 4.5; // seconds of travel per card — calm, readable
  const duration = +(n * perCard).toFixed(2);
  const anim = `slide_${uid}`;
  const gap = 30; // px between cards (margin → guaranteed no overlap)
  const capFont = r.captionFont;
  const photoH = fitPhotoH(bandHeight, capFont);
  const w = Math.round(photoH * (r.cardW / r.cardPhotoH));
  const card = (c: VocabItem, i: number): string =>
    `<div style="flex:none;margin:0 ${gap / 2}px">` +
    polaroidCard(c, w, photoH, capFont, TILTS[i % TILTS.length] ?? 0) +
    `</div>`;
  const copy = cards.map(card).join("");
  const keyframes = `@keyframes ${anim}{from{transform:translateX(0)}to{transform:translateX(-50%)}}`;
  const settled = `@media (prefers-reduced-motion:reduce){[data-anim="${anim}"]{animation:none!important}}`;
  // Soft edge-fade: cards melt in/out at the band's left/right instead of hard-clipping at the edge.
  const edgeFade =
    "mask-image:linear-gradient(to right,transparent,black 6%,black 94%,transparent);" +
    "-webkit-mask-image:linear-gradient(to right,transparent,black 6%,black 94%,transparent);";
  return (
    `<div data-image-slot="shared" style="height:${bandHeight}px;flex:none;position:relative;overflow:hidden;${edgeFade}">` +
    `<style>${keyframes}${settled}</style>` +
    `<div data-anim="${anim}" style="position:absolute;top:0;left:0;height:100%;width:max-content;display:flex;` +
    `align-items:center;animation:${anim} ${duration}s linear infinite">${copy}${copy}</div>` +
    `</div>`
  );
}

/**
 * STATIC collage — the original tilted-polaroid pile (overlaps, ≤5 photos). One anchor card + smaller
 * snapshots; cards shrink as the count grows so they span the width. `bandWidth` is the container width
 * the strip must span (portrait body = 976; a landscape banner passes its own width).
 */
function staticCollage(
  cards: VocabItem[],
  r: Register,
  bandHeight: number,
  bandWidth: number,
): string {
  const n = cards.length;
  const baseW = Math.min(r.cardW, Math.floor((bandWidth + (n - 1) * 20) / Math.max(1, n)) - 8);
  const html = cards
    .map((c, i) => {
      const isAnchor = i === 0;
      const scale = isAnchor ? 1 : 0.86;
      const w = Math.round(baseW * scale);
      const photoH = Math.round(r.cardPhotoH * scale);
      const tilt = TILTS[i % TILTS.length] ?? 0;
      const overlap = i === 0 ? 0 : -18;
      const vshift = i % 2 === 0 ? 0 : isAnchor ? 0 : -14;
      const z = isAnchor ? 3 : 2 - (i % 2);
      const cap = Math.round(r.captionFont * (isAnchor ? 1 : 0.92));
      return (
        `<div style="width:${w}px;background:var(--color-surface);padding:10px 10px 0;` +
        `box-shadow:0 10px 24px rgba(42,26,14,0.28);transform:rotate(${tilt}deg);` +
        `margin-left:${overlap}px;margin-top:${vshift}px;z-index:${z};position:relative">` +
        // tape accent
        `<div style="position:absolute;top:-9px;left:50%;transform:translateX(-50%) rotate(${-tilt}deg);` +
        `width:64px;height:20px;background:rgba(242,181,58,0.55);box-shadow:0 1px 2px rgba(42,26,14,0.2)"></div>` +
        `<div style="height:${photoH}px;position:relative;overflow:hidden">` +
        `<img data-img-item="${c.id}" data-img-index="0" alt="${esc(c.name)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></div>` +
        `<div style="text-align:center;font-size:${cap}px;font-weight:700;padding:10px 6px 12px">${esc(c.name)}</div>` +
        `</div>`
      );
    })
    .join("");
  return `<div data-image-slot="shared" style="height:${bandHeight}px;flex:none;display:flex;justify-content:center;align-items:center">${html}</div>`;
}

// ── 1. masthead (shell-level) ───────────────────────────────────────────────────────────────────────
function masthead(title: string, tagline: string | null, brand: BrandInput | undefined): string {
  // The LLM controls the title text, so the font SHRINKS-TO-FIT one line inside the fixed 96px band
  // (independent of the body register). Gold's "Street & Sweets" is 15 chars @ 44px; a long title
  // steps down proportionally, floored at 26px, and never wraps (white-space:nowrap).
  const size = Math.max(26, Math.min(46, Math.floor((46 * 15) / Math.max(15, title.length))));
  const tag = tagline
    ? `<div style="font-size:13px;font-weight:800;letter-spacing:2px;color:var(--color-chip);text-transform:uppercase;white-space:nowrap">${esc(tagline)}</div>`
    : "";
  // When a brand logo is provided, replace the empty white logo box with a src-less <img data-brand-logo>
  // the packager inlines to the resolved logo data-URI (D18).
  const logo =
    brand !== undefined
      ? `<img data-brand-logo alt="${esc(brand.name ?? "")}" style="height:46px;max-width:170px;object-fit:contain">`
      : `<div style="flex:none;width:170px;height:46px;background:var(--color-surface);border:2px solid var(--color-text)"></div>`;
  return (
    `<header style="height:96px;flex:none;display:flex;align-items:center;justify-content:space-between;` +
    `gap:16px;padding:0 36px;border-bottom:3px solid var(--color-text);overflow:hidden">` +
    `<div style="display:flex;align-items:baseline;gap:16px;min-width:0">` +
    `<div style="font-family:'Shrikhand',serif;font-size:${size}px;line-height:1;color:var(--color-accent);white-space:nowrap">${esc(title)}</div>` +
    tag +
    `</div>` +
    logo +
    `</header>`
  );
}

// ── VocabularyMetrics — the size/space numbers the generic layout engine fits on ─────────────────────
function metricsFor(r: Register): VocabularyMetrics {
  return {
    sectionHeight: (itemCount, internalCols) =>
      headerH(r, false) + Math.ceil(itemCount / Math.max(1, internalCols)) * rowH(r, false),
    // An all-unknown group can hand in an EMPTY array; the leading `1` floors the fold so an empty
    // array yields Math.max(1) = 1 (not Math.max() = -Infinity).
    groupHeight: (itemCounts) => headerH(r, true) + Math.max(1, ...itemCounts) * rowH(r, true),
    photoBandHeight: () => collageBandHeight(r),
    flowRowHeight: () => rowH(r, false),
    flowLeadHeight: () => headerH(r, false) + rowH(r, false),
    cueHeight: () => r.sectionTitle * 0.66 * 1.1 + r.headerMb,
    sectionInternalCols: (itemCount, max) => (itemCount <= 4 ? 1 : max),
  };
}

// ── The vocabulary ───────────────────────────────────────────────────────────────────────────────
export const dhabaVocabulary: ComponentVocabulary = {
  id: "dhaba",
  version: 1,
  registerNames: ["L", "M", "S"],
  defaultPhotoMode: "filmstrip",
  minStreamWidth: 430,
  sectionGap: 14,
  landscapeBannerHeight: 224,

  contentBox(canvas: VocabCanvas): { width: number; height: number } {
    return {
      width: canvas.width - 2 * FRAME - 2 * PAD_SIDE,
      height: canvas.height - 2 * FRAME - HEADER - PAD_TOP - PAD_BOTTOM,
    };
  },

  metrics(register) {
    return metricsFor(registerByName(register));
  },

  renderShell(args: ShellArgs): string {
    // The OUTERMOST element carries data-composed="dhaba@1" and NO CSS-variable declarations, DOCTYPE,
    // <head> or font <link>s — the packager owns the document + fonts and declares the theme tokens.
    return (
      `<div data-composed="dhaba@1" style="width:${args.canvas.width}px;height:${args.canvas.height}px;` +
      `background:repeating-linear-gradient(45deg,var(--color-accent) 0 16px,var(--color-stripe) 16px 32px);` +
      `padding:16px;box-sizing:border-box;overflow:hidden">` +
      `<div style="width:100%;height:100%;background:var(--color-bg);color:var(--color-text);` +
      `font-family:'Archivo',sans-serif;display:flex;flex-direction:column;overflow:hidden">` +
      masthead(args.title, args.tagline, args.brand) +
      args.bodyHtml +
      `</div></div>`
    );
  },

  renderSection(args) {
    const r = registerByName(args.register);
    return (
      `<div>` +
      sectionHeader(args.number, args.section.title, r, false) +
      priceList(args.section.items, args.internalCols, r, false) +
      `</div>`
    );
  },

  renderGroup(args) {
    return triBand(args.sections, args.startNumber, registerByName(args.register));
  },

  renderPhotoBand(args) {
    const r = registerByName(args.register);
    if (args.mode === "crossfade") return crossfadeDeck(args.items, r, args.bandHeight, args.uid);
    if (args.mode === "filmstrip") return filmstrip(args.items, r, args.bandHeight, args.uid);
    return staticCollage(args.items, r, args.bandHeight, args.bandWidth);
  },

  renderFlowLead(args) {
    const r = registerByName(args.register);
    const first = args.section.items[0];
    // The lead GLUES the numbered header to the first row so a section header never orphans at a break.
    return (
      sectionHeader(args.number, args.section.title, r) + (first ? priceRow(first, r, false) : "")
    );
  },

  renderFlowRow(args) {
    return priceRow(args.item, registerByName(args.register), false);
  },

  renderContinuationCue(args) {
    return continuationCue(args.sectionTitle, registerByName(args.register));
  },

  promptNotes: {
    section: "a numbered category with dotted-leader price rows (1–3 columns, sized automatically)",
    group:
      "2–3 SMALL categories side by side in one compact band with vertical dividers — use for categories of ~2–5 items",
    photoBand:
      "a filmstrip of tilted white polaroid photo cards with captions, cycling through all chosen photos",
  },
};
