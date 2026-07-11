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
const TILTS = [-2, 1.5, -1, 2.5, -1.5, 1, -2];

/**
 * polaroidCollage — tilted white cards, photo + caption, slight overlaps and a tape accent.
 * `bandWidth` is the width of the container the strip must span (portrait body = 976; a landscape
 * newspaper column or a full-width banner pass their own width) so cards size to fill it.
 */
export function polaroidCollage(
  cards: MenuItem[],
  r: Register,
  bandHeight: number,
  bandWidth = 976,
): string {
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
