/**
 * Component catalog — the CLOSED vocabulary.
 *
 * Five hand-designed components mined from the gold board
 * `reference-boards/3b-dhaba-poster-street-sweets.dc.html` (de-runtimed: no <x-dc>, no support.js,
 * no image-slot custom element — plain static HTML + inline CSS):
 *
 *   1. masthead        — title band (Shrikhand) below the truck-art stripe frame (shell-level).
 *   2. sectionHeader   — teal numbered chip + Shrikhand chilli title + ink rule to the edge.
 *   3. priceList       — item rows (name → dotted leader → chilli price), 1/2/3 columns.
 *   4. polaroidCollage — 3–7 tilted white polaroid cards with captions, slight overlaps + tape.
 *   5. triBand         — 2–3 small sections side by side, divided by vertical ink rules.
 *
 * The LLM never emits HTML. It emits a small `Composition` (see the Zod schema below); the renderer
 * expands it by calling these templates with concrete sizes chosen by the fitter.
 */

import { z } from "zod";

// ── Theme tokens (verbatim from themes/dhaba.theme.json → tokens.colors) ───────────────────────────
export const TOKENS = {
  bg: "#f8ecd4",
  surface: "#ffffff",
  text: "#2a1a0e",
  muted: "#57503f",
  accent: "#c22415",
  price: "#c22415",
  chip: "#0d6e5c",
  stripe: "#f2b53a",
} as const;

/** The dotted-leader / thin-divider ink colour — theme `text` at 0.35 alpha (gold board value). */
const LEADER = "rgba(42,26,14,0.35)";
const DIVIDER = "rgba(42,26,14,0.2)";

// ── Domain types ───────────────────────────────────────────────────────────────────────────────────
export interface MenuItem {
  id: string;
  name: string;
  price: number | null;
  imageUrl?: string;
}
export interface ResolvedSection {
  title: string;
  items: MenuItem[];
}
export interface Canvas {
  width: number;
  height: number;
}

/**
 * How a `collage` block renders its photos:
 *   - "collage"   — the original static tilted-polaroid pile (overlaps, ≤5 photos).
 *   - "crossfade" — a pure-CSS stacked-layer deck: one polaroid at a time, cross-fading through ALL
 *                   photos on an infinite loop. Every layer carries its OWN image + caption, so the
 *                   caption can never desync from the photo (photo-truth by construction).
 *   - "filmstrip" — a pure-CSS marquee: a horizontal track of spaced, tilted polaroids scrolling
 *                   continuously; the track is duplicated once and translated -50% for a seamless
 *                   loop. Each card carries its own caption, so image + caption travel as one unit.
 * All three are self-contained static HTML; the motion is CSS `@keyframes` only (no JS, no library).
 */
export type PhotoMode = "collage" | "crossfade" | "filmstrip";

/** One size register (px). The fitter picks L/M/S for the whole board; templates read these numbers. */
export interface Register {
  name: "L" | "M" | "S";
  // full-width section header
  chip: number;
  chipFont: number;
  sectionTitle: number;
  headerMb: number;
  // full-width rows
  rowName: number;
  rowPad: number;
  colGap: number;
  // triBand (small) variants
  smChip: number;
  smChipFont: number;
  smSectionTitle: number;
  smRowName: number;
  smRowPad: number;
  smHeaderMb: number;
  // polaroid collage
  cardW: number;
  cardPhotoH: number;
  captionFont: number;
}

// ── The composition schema (the LLM's "order form") ─────────────────────────────────────────────────
//
// Flat block object with a `type` enum + optional per-type fields (the fallback shape the brief calls
// for): no `anyOf` / discriminated union at all, so OpenRouter's strict json_schema validator has
// nothing to reject. The type/field pairing is validated in code after parse (see validateComposition).
// The masthead + stripe frame are shell-level (always emitted from `title`), so they are NOT block
// types — the LLM only chooses body blocks.

export const blockTypes = ["section", "triBand", "collage"] as const;

export const blockSchema = z
  .object({
    type: z.enum(blockTypes).describe("Which component this block renders."),
    section: z
      .string()
      .optional()
      .describe('For type "section": the exact section title to render full-width.'),
    sections: z
      .array(z.string())
      .optional()
      .describe('For type "triBand": 2–3 exact section titles to place side by side.'),
    itemIds: z
      .array(z.string())
      .optional()
      .describe('For type "collage": 3–5 item ids chosen from the photo list.'),
  })
  .describe("One board block. Fill only the field(s) named for its type.");

export const compositionSchema = z.object({
  title: z.string().describe("Short board masthead title, e.g. 'Street & Sweets'."),
  blocks: z.array(blockSchema).describe("Board blocks, top to bottom."),
});

export type Block = z.infer<typeof blockSchema>;
export type Composition = z.infer<typeof compositionSchema>;

/** JSON Schema for the OpenRouter `response_format.json_schema.schema` (strict-mode compatible). */
export function compositionJsonSchema(): unknown {
  return z.toJSONSchema(compositionSchema);
}

// ── helpers ──────────────────────────────────────────────────────────────────────────────────────
const money = (p: number | null): string =>
  p === null ? "" : `$${p.toFixed(2)}`;
const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// ── 2. sectionHeader ───────────────────────────────────────────────────────────────────────────────
export function sectionHeader(n: number, title: string, r: Register, small = false): string {
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

// ── 3. priceList ──────────────────────────────────────────────────────────────────────────────────
function priceRow(item: MenuItem, r: Register, small: boolean): string {
  const nameSize = small ? r.smRowName : r.rowName;
  const pad = small ? r.smRowPad : r.rowPad;
  const priceHtml =
    item.price === null
      ? `<span style="font-size:${Math.round(nameSize * 0.7)}px;font-weight:800;color:var(--color-price);border:2px solid var(--color-price);padding:0 6px">MP</span>`
      : `<span style="font-size:${nameSize}px;font-weight:800;color:var(--color-price);font-variant-numeric:tabular-nums">${money(item.price)}</span>`;
  return (
    `<div style="display:flex;align-items:baseline;gap:10px;padding:${pad}px 0">` +
    `<span style="font-size:${nameSize}px;font-weight:600">${esc(item.name)}</span>` +
    `<span style="flex:1;border-bottom:2px dotted ${LEADER};transform:translateY(-4px)"></span>` +
    priceHtml +
    `</div>`
  );
}

/** priceList — item rows flowing top-to-bottom then across `columns` (1/2/3), like the gold grid. */
export function priceList(items: MenuItem[], columns: number, r: Register, small = false): string {
  const cols = Math.max(1, Math.min(3, columns));
  const rows = Math.ceil(items.length / cols);
  const cells = items.map((it) => priceRow(it, r, small)).join("");
  const gap = small ? 24 : r.colGap;
  return (
    `<div style="display:grid;grid-auto-flow:column;grid-template-rows:repeat(${rows},auto);` +
    `grid-template-columns:repeat(${cols},1fr);column-gap:${gap}px">${cells}</div>`
  );
}

// ── 5. triBand ────────────────────────────────────────────────────────────────────────────────────
export function triBand(
  sections: ResolvedSection[],
  startNumber: number,
  r: Register,
): string {
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

// ── 4. polaroidCollage ────────────────────────────────────────────────────────────────────────────
const TILTS = [-2, 1.5, -1, 2.5, -1.5, 1, -2.5, 2, -1.5, 1.5];
const CARD_PAD_TOP = 10; // white polaroid margin above the photo (px)

/** Caption band height (text + its 10/12 vertical padding) for a given caption font size. */
function captionBandH(capFont: number): number {
  return Math.round(capFont * 1.25) + 22;
}

/**
 * One white polaroid: tape accent + photo + caption, tilted by `tilt`. The image and caption live in
 * the SAME element, so whatever a carousel does to this card (fade it, slide it), photo + caption move
 * together — the caption can never show over a different dish's photo. `position:relative` anchors the
 * tape; the tape counter-rotates so it reads level against the tilt.
 */
function polaroidCard(c: MenuItem, w: number, photoH: number, capFont: number, tilt: number): string {
  return (
    `<div style="width:${w}px;background:var(--color-surface);padding:${CARD_PAD_TOP}px 10px 0;` +
    `box-shadow:0 10px 24px rgba(42,26,14,0.28);transform:rotate(${tilt}deg);position:relative">` +
    `<div style="position:absolute;top:-9px;left:50%;transform:translateX(-50%) rotate(${-tilt}deg);` +
    `width:64px;height:20px;background:rgba(242,181,58,0.55);box-shadow:0 1px 2px rgba(42,26,14,0.2)"></div>` +
    `<div style="height:${photoH}px;position:relative;overflow:hidden">` +
    `<img src="${c.imageUrl ?? ""}" alt="${esc(c.name)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></div>` +
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
 * Variant A — CROSS-FADE DECK (pure CSS). N polaroids absolutely stacked in a fixed-height band; each
 * is visible for `dwell`s then cross-fades to the next, looping through ALL N forever. Each layer runs
 * the SAME keyframes over the full `cycle = N*dwell`, staggered by `animation-delay: i*dwell`, with
 * `backwards` fill so a layer is invisible (opacity 0) until its slot. Its visible window sits at the
 * head of its own timeline: fade-in over the first `fade`s, hold, fade-out over the last `fade`s of the
 * slot — which lands exactly on the NEXT layer's fade-in, so the two cross-dissolve. No overlap of
 * cards (only one is opaque at a time); nothing below shifts (band height is reserved).
 */
function crossfadeDeck(
  cards: MenuItem[],
  r: Register,
  bandHeight: number,
  _bandWidth: number,
  uid: string,
): string {
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
  const layers = cards
    .map((c, i) => {
      const tilt = TILTS[i % TILTS.length];
      const delay = (i * dwell).toFixed(2);
      return (
        `<div style="position:absolute;inset:0;display:flex;justify-content:center;align-items:center;` +
        `opacity:0;animation:${anim} ${cycle}s linear ${delay}s infinite backwards">` +
        polaroidCard(c, w, photoH, capFont, tilt) +
        `</div>`
      );
    })
    .join("");
  return (
    `<style>${keyframes}</style>` +
    `<div style="height:${bandHeight}px;flex:none;position:relative;overflow:hidden">${layers}</div>`
  );
}

/**
 * Variant B — SLIDING FILMSTRIP / marquee (pure CSS). A row of spaced, tilted polaroids that scrolls
 * left forever. The track holds TWO identical copies of the N cards; `translateX(0 → -50%)` linear
 * infinite moves it by exactly one copy's width, at which point copy 2 sits where copy 1 began — a
 * seamless wrap. Cards are separated by margin (never overlapping) and each carries its own caption,
 * so image + caption travel as one unit. Duration = N * `perCard`s so it reads calm, not frantic.
 */
function filmstrip(
  cards: MenuItem[],
  r: Register,
  bandHeight: number,
  _bandWidth: number,
  uid: string,
): string {
  const n = cards.length;
  const perCard = 4.5; // seconds of travel per card — calm, readable
  const duration = +(n * perCard).toFixed(2);
  const anim = `slide_${uid}`;
  const gap = 30; // px between cards (margin → guaranteed no overlap)
  const capFont = r.captionFont;
  const photoH = fitPhotoH(bandHeight, capFont);
  const w = Math.round(photoH * (r.cardW / r.cardPhotoH));
  const card = (c: MenuItem, i: number): string =>
    `<div style="flex:none;margin:0 ${gap / 2}px">` +
    polaroidCard(c, w, photoH, capFont, TILTS[i % TILTS.length]!) +
    `</div>`;
  const copy = cards.map(card).join("");
  const keyframes =
    `@keyframes ${anim}{from{transform:translateX(0)}to{transform:translateX(-50%)}}`;
  return (
    `<style>${keyframes}</style>` +
    `<div style="height:${bandHeight}px;flex:none;position:relative;overflow:hidden">` +
    `<div style="position:absolute;top:0;left:0;height:100%;width:max-content;display:flex;` +
    `align-items:center;animation:${anim} ${duration}s linear infinite">${copy}${copy}</div>` +
    `</div>`
  );
}

/**
 * polaroidCollage — tilted white cards, photo + caption, tape accent.
 * `mode` picks the presentation: the original static overlap pile ("collage", default), or one of the
 * two pure-CSS carousels ("crossfade" / "filmstrip") that cycle through ALL the block's photos so a
 * menu with more photos than fit at once still shows every one. `uid` scopes the carousel's @keyframes
 * name so multiple carousels on one board don't collide.
 * `bandWidth` is the width of the container the strip must span (portrait body = 976; a landscape
 * newspaper column or a full-width banner pass their own width) so cards size to fill it.
 */
export function polaroidCollage(
  cards: MenuItem[],
  r: Register,
  bandHeight: number,
  bandWidth = 976,
  mode: PhotoMode = "collage",
  uid = "c0",
): string {
  if (mode === "crossfade") return crossfadeDeck(cards, r, bandHeight, bandWidth, uid);
  if (mode === "filmstrip") return filmstrip(cards, r, bandHeight, bandWidth, uid);

  const n = cards.length;
  // One anchor card + smaller snapshots. Shrink cards as the count grows so they span the width.
  const baseW = Math.min(r.cardW, Math.floor((bandWidth + (n - 1) * 20) / n) - 8);
  const html = cards
    .map((c, i) => {
      const isAnchor = i === 0;
      const scale = isAnchor ? 1 : 0.86;
      const w = Math.round(baseW * scale);
      const photoH = Math.round(r.cardPhotoH * scale);
      const tilt = TILTS[i % TILTS.length];
      const overlap = i === 0 ? 0 : -18;
      const vshift = i % 2 === 0 ? 0 : (isAnchor ? 0 : -14);
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
        `<img src="${c.imageUrl ?? ""}" alt="${esc(c.name)}" style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover"></div>` +
        `<div style="text-align:center;font-size:${cap}px;font-weight:700;padding:10px 6px 12px">${esc(c.name)}</div>` +
        `</div>`
      );
    })
    .join("");
  return (
    `<div style="height:${bandHeight}px;flex:none;display:flex;justify-content:center;align-items:center">${html}</div>`
  );
}

// ── 1. masthead (shell-level) ───────────────────────────────────────────────────────────────────────
export function masthead(title: string, tagline: string | null, _r: Register): string {
  // The LLM controls the title text, so the font SHRINKS-TO-FIT one line inside the fixed 96px band
  // (independent of the body register). Gold's "Street & Sweets" is 15 chars @ 44px; a long title
  // steps down proportionally, floored at 26px, and never wraps (white-space:nowrap).
  const size = Math.max(26, Math.min(46, Math.floor((46 * 15) / Math.max(15, title.length))));
  const tag = tagline
    ? `<div style="font-size:13px;font-weight:800;letter-spacing:2px;color:var(--color-chip);text-transform:uppercase;white-space:nowrap">${esc(tagline)}</div>`
    : "";
  return (
    `<header style="height:96px;flex:none;display:flex;align-items:center;justify-content:space-between;` +
    `gap:16px;padding:0 36px;border-bottom:3px solid var(--color-text);overflow:hidden">` +
    `<div style="display:flex;align-items:baseline;gap:16px;min-width:0">` +
    `<div style="font-family:'Shrikhand',serif;font-size:${size}px;line-height:1;color:var(--color-accent);white-space:nowrap">${esc(title)}</div>` +
    tag +
    `</div>` +
    `<div style="flex:none;width:170px;height:46px;background:var(--color-surface);border:2px solid var(--color-text)"></div>` +
    `</header>`
  );
}
