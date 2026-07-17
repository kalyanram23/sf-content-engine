/**
 * The `bubblegum` component vocabulary (D71/D78) — "BUBBLEGUM: candy-pop toy drop on a deep grape
 * stage": the only DARK theme. Everything sits on a deep-grape stage under a very subtle film-grain
 * overlay (inline SVG fractalNoise, opacity ≤ 0.04 — intentional, never muddying text) with a few
 * tiny candy sparkles in the margins. ALL menu content lives on large ROUNDED glossy sticker cards —
 * lighter-grape surface, border-radius 28px (32px for the one big landscape card), NO ink borders —
 * each wearing a subtle glossy top sheen (a 6% near-white gradient band). Sections open with a
 * fully-rounded CANDY PILL header whose background rotates by section number (coral → mint → sunny
 * yellow), dark Anton all-caps text with a small dark rounded number chip inside the pill; Inter
 * rows run a dotted lavender leader into a bold sunny-yellow price (null price → a small rounded
 * "MP" pill). Groups put 2–3 small sections inside ONE sticker card, divided by CHUNKY ROUNDED BARS
 * (6px, fully rounded — never thin hairlines). Photos are rounded-20px stickers with a thick 6px
 * near-white border, tilted alternately ±2deg, each with a fully-rounded candy caption pill
 * (rotating by card index) in the SAME element; the default band mode is CROSSFADE — one big ~4:3
 * card at a time (the identity's photo cross-fade). The header is one compact row: Anton near-white
 * title with a small 4-point sparkle flourish, muted tagline, logo on a rounded surface chip. NO
 * sharp corners anywhere (nothing below radius 12), no serif type, no rgba() literals (low-alpha
 * inks are color-mix over tokens).
 *
 * Built on the shared toolbox (src/vocabularies/shared/) — binding/escaping, carousel mechanics,
 * register math and masthead sizing live there; this file holds only bubblegum's visual language.
 * Engine-legal output: one `data-composed="bubblegum@1"` root, tokens as `var(--color-*)` only,
 * `data-item-id`/`data-bind="price"` on every row, src-less `data-img-item` photo placeholders.
 */

import type {
  ComponentVocabulary,
  ShellArgs,
  VocabCanvas,
  VocabItem,
  VocabSection,
} from "../../ports/vocabulary-registry";
import {
  bindName,
  bindPrice,
  bindPrices,
  bindRow,
  brandLogoPlaceholder,
  cardSlotAttr,
  esc,
  imgPlaceholder,
  money,
} from "../shared/binding";
import { crossfadeBand, filmstripBand, staticBand } from "../shared/carousels";
import { shrinkToFitPx } from "../shared/masthead";
import { metricsFromNumbers } from "../shared/registers";

// ── page geometry (px) ───────────────────────────────────────────────────────────────────────────
/** Sticker-card corner radii — nothing on this board dips below 12px (theme dont: no sharp corners). */
const CARD_RADIUS = 28;
const LAND_CARD_RADIUS = 32;
const PHOTO_RADIUS = 20;
/** Thick near-white border every photo sticker wears. */
const PHOTO_BORDER = 6;
/** Photo stickers keep a generous ~4:3 aspect (width = height × this) in every band mode. */
const PHOTO_RATIO = 4 / 3;
/** Photo-card tilt: even card indices lean right, odd lean left. */
const PHOTO_TILT_DEG = 2;

// portrait: section cards sit directly on the grape stage inside these margins
const PAD_SIDE = 44;
const PAD_TOP = 24;
const PAD_BOTTOM = 36;
// landscape: the body is ONE full-height rounded sticker card; slim margins keep the interior wide
// enough for 4 × minStreamWidth columns (1816px body → 421px columns).
const LAND_PAD_TOP = 16;
const LAND_PAD_SIDE = 26;
const LAND_PAD_BOTTOM = 22;
const LAND_CARD_PAD = 26;

/** ONE compact header row — identity keeps it slim, never a masthead. */
const headerH = (canvas: VocabCanvas): number => (canvas.height > canvas.width ? 150 : 104);

const ROW_LINE = 1.3; // rows declare this line-height INLINE, so estimates match the render
const TITLE_LINE = 1.1; // Anton pill headers

/** Low-alpha inks — always via color-mix over a token (token-pure; no raw hex, no rgba literals). */
const LEADER = "color-mix(in srgb,var(--color-muted) 55%,transparent)";
const CUE_BAR = "color-mix(in srgb,var(--color-muted) 40%,transparent)";
/** The glossy top sheen every sticker card wears (gloss is welcome in THIS theme). */
const GLOSS = "color-mix(in srgb,var(--color-text) 6%,transparent)";

/** Film-grain opacity — identity demands the grain, QA demands it never muddies text (≤ 0.04). */
const GRAIN_OPACITY = 0.035;

// ── registers ────────────────────────────────────────────────────────────────────────────────────
type RegisterName = "L" | "M" | "S";

interface Register {
  name: RegisterName;
  pillFont: number; // Anton pill-header title
  pillPadV: number;
  pillPadH: number;
  chipFont: number; // dark number chip inside the pill
  rowName: number; // Inter item name
  rowPad: number;
  colGap: number;
  cardPadV: number; // interior padding of a section sticker card
  cardPadH: number;
  smPillFont: number; // group-member (small) variants
  smPillPadV: number;
  smRowName: number;
  smRowPad: number;
  memberPadV: number;
  photoH: number; // base photo sticker height (band growth scales it; 4:3 keeps the aspect)
  captionFont: number;
}

const REGISTERS: Record<RegisterName, Register> = {
  L: {
    name: "L",
    pillFont: 30,
    pillPadV: 9,
    pillPadH: 20,
    chipFont: 13,
    rowName: 22,
    rowPad: 6,
    colGap: 48,
    cardPadV: 20,
    cardPadH: 26,
    smPillFont: 19,
    smPillPadV: 6,
    smRowName: 19,
    smRowPad: 5,
    memberPadV: 16,
    photoH: 210,
    captionFont: 17,
  },
  M: {
    name: "M",
    pillFont: 25,
    pillPadV: 8,
    pillPadH: 18,
    chipFont: 12,
    rowName: 19,
    rowPad: 4,
    colGap: 40,
    cardPadV: 18,
    cardPadH: 22,
    smPillFont: 16,
    smPillPadV: 5,
    smRowName: 17,
    smRowPad: 4,
    memberPadV: 13,
    photoH: 180,
    captionFont: 15,
  },
  S: {
    name: "S",
    pillFont: 20,
    pillPadV: 6,
    pillPadH: 14,
    chipFont: 10,
    rowName: 16,
    rowPad: 3,
    colGap: 32,
    cardPadV: 14,
    cardPadH: 18,
    smPillFont: 14,
    smPillPadV: 4,
    smRowName: 15,
    smRowPad: 3,
    memberPadV: 10,
    photoH: 150,
    captionFont: 13,
  },
};

const registerByName = (name: string): Register => REGISTERS[name as RegisterName] ?? REGISTERS.M;

// ── the candy rotation (deterministic, from section/card indices only) ───────────────────────────
/** Section-pill backing rotates by section number: 1 → coral, 2 → mint, 0 → sunny yellow. */
const pillBg = (n: number): string =>
  n % 3 === 1
    ? "var(--color-accent)"
    : n % 3 === 2
      ? "var(--color-accent-strong)"
      : "var(--color-price)";

/** Caption-pill backing rotates by card index: 0 → coral, 1 → mint, 2 → sunny yellow. */
const captionBg = (i: number): string =>
  i % 3 === 0
    ? "var(--color-accent)"
    : i % 3 === 1
      ? "var(--color-accent-strong)"
      : "var(--color-price)";

// ── metric arithmetic (fit estimates; the landscape pass measures for real) ─────────────────────
const rowH = (r: Register, small: boolean): number =>
  (small ? r.smRowName : r.rowName) * ROW_LINE + (small ? r.smRowPad : r.rowPad) * 2;
/** The pill header block: pill box (title line + pill padding) + margin before the rows. */
const pillBlockH = (r: Register, small: boolean): number =>
  Math.round((small ? r.smPillFont : r.pillFont) * TITLE_LINE) +
  2 * (small ? r.smPillPadV : r.pillPadV) +
  (small ? 10 : 12);
/** Everything a sticker card adds around its rows: interior padding (no border, no shadow). */
const cardChrome = (padV: number): number => 2 * padV;
/** Caption pill box: caption line + 2×6px pill padding. */
const captionH = (capFont: number): number => Math.round(capFont * ROW_LINE) + 12;
/** Tilt spill (±2deg on a ~4:3 card ≈ 0.047 × photo height) + centering slack inside the band. */
const BAND_SLACK = 26;
const photoBandH = (r: Register): number =>
  r.photoH + 2 * PHOTO_BORDER + 8 + captionH(r.captionFont) + BAND_SLACK;
const cueFont = (r: Register): number => Math.max(13, Math.round(r.pillFont * 0.55));

// ── the rounded glossy sticker card ──────────────────────────────────────────────────────────────
/**
 * One sticker card — lighter-grape surface, big rounded corners, NO border, with a subtle glossy
 * sheen over its top third (a 6% near-white gradient; `overflow:hidden` clips it to the corners).
 */
const stickerCard = (radius: number, padV: number, padH: number, inner: string): string =>
  `<div style="position:relative;overflow:hidden;background:var(--color-surface);` +
  `border-radius:${radius}px;padding:${padV}px ${padH}px">` +
  `<div style="position:absolute;top:0;left:0;right:0;height:34%;` +
  `background:linear-gradient(to bottom,${GLOSS},transparent);pointer-events:none"></div>` +
  inner +
  `</div>`;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * The candy pill header: a fully-rounded pill whose backing rotates by section number, carrying a
 * small dark rounded number chip + dark Anton all-caps title. Dark-on-candy passes WCAG easily
 * (bg-on-coral ≈ 6.4:1, bg-on-mint ≈ 10.8:1, bg-on-yellow ≈ 11:1).
 */
function pillHeader(n: number, title: string, r: Register, small = false): string {
  const font = small ? r.smPillFont : r.pillFont;
  const padV = small ? r.smPillPadV : r.pillPadV;
  const padH = small ? Math.max(10, r.pillPadH - 6) : r.pillPadH;
  const chipFont = small ? Math.max(9, r.chipFont - 2) : r.chipFont;
  const mb = small ? 10 : 12;
  return (
    `<div style="display:flex;margin-bottom:${mb}px">` +
    `<div style="display:flex;align-items:center;gap:8px;min-width:0;background:${pillBg(n)};` +
    `border-radius:999px;padding:${padV}px ${padH}px">` +
    `<span style="flex:none;background:var(--color-bg);color:var(--color-text);border-radius:999px;` +
    `font-size:${chipFont}px;font-weight:700;line-height:${ROW_LINE};padding:1px 8px">${pad2(n)}</span>` +
    `<span style="font-family:'Anton',sans-serif;font-size:${font}px;line-height:${TITLE_LINE};` +
    `text-transform:uppercase;letter-spacing:1px;color:var(--color-bg);min-width:0;` +
    `white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(title)}</span>` +
    `</div>` +
    `</div>`
  );
}

/** Continuation cue at a spilled landscape column top: muted Inter italic beside a CHUNKY 4px
 * fully-rounded bar — never a thin rule (theme dont). */
function continuationCue(title: string, r: Register): string {
  const size = cueFont(r);
  return (
    `<div style="display:flex;align-items:center;gap:10px;margin-bottom:8px">` +
    `<span style="flex:none;font-size:${size}px;font-weight:600;font-style:italic;` +
    `line-height:${ROW_LINE};color:var(--color-muted)">${esc(title)} (cont.)</span>` +
    `<span style="flex:1;height:4px;border-radius:999px;background:${CUE_BAR}"></span>` +
    `</div>`
  );
}

// ── price rows: Inter name → dotted lavender leader → bold sunny-yellow price ────────────────────
function priceRow(item: VocabItem, r: Register, small: boolean): string {
  const nameSize = small ? r.smRowName : r.rowName;
  const pad = small ? r.smRowPad : r.rowPad;
  const priceStyle =
    `font-size:${nameSize}px;font-weight:700;color:var(--color-price);` +
    `font-variant-numeric:tabular-nums;flex:none`;
  // Sized items → one pill per size, each data-size tagged (spec §4); the MP pill stays distinct.
  // Null price → a small fully-rounded pill (lifted-grape backing, yellow "MP" — ≈ 8.2:1).
  const priceHtml =
    item.sizes !== undefined && item.sizes.length > 0
      ? bindPrices(item, priceStyle)
      : item.price === null
        ? bindPrice(
            "MP",
            `font-size:${Math.max(10, Math.round(nameSize * 0.7))}px;font-weight:700;` +
              `color:var(--color-price);background:var(--color-surface-strong);` +
              `border-radius:999px;padding:1px 10px;line-height:${ROW_LINE};flex:none`,
          )
        : bindPrice(money(item.price), priceStyle);
  // line-height is declared HERE (inherited by the name/price spans) so the rendered row height is
  // exactly the metric estimate — independent of the packaged root's preflight line-height.
  return bindRow(
    item,
    `display:flex;align-items:baseline;gap:10px;padding:${pad}px 0;line-height:${ROW_LINE};` +
      `font-family:'Inter',sans-serif`,
    bindName(item.name, `font-size:${nameSize}px;font-weight:600;color:var(--color-text)`) +
      `<span style="flex:1;border-bottom:2px dotted ${LEADER};transform:translateY(-4px)"></span>` +
      priceHtml,
  );
}

/** Rows flowing top-to-bottom then across `columns` (1–3) inside the card. */
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

// ── group: 2–3 small sections inside ONE sticker card, split by chunky rounded bars ──────────────
function groupCard(sections: VocabSection[], startNumber: number, r: Register): string {
  const divider =
    `<div style="flex:none;width:6px;border-radius:999px;` +
    `background:var(--color-surface-strong);margin:0 16px"></div>`;
  const cols = sections
    .map(
      (sec, i) =>
        `<div style="flex:1;min-width:0">` +
        pillHeader(startNumber + i, sec.title, r, true) +
        priceList(sec.items, 1, r, true) +
        `</div>`,
    )
    .join(divider);
  return stickerCard(
    CARD_RADIUS,
    r.memberPadV,
    18,
    `<div style="display:flex;align-items:stretch">${cols}</div>`,
  );
}

// ── photo stickers: rounded, thick near-white border, caption pill in the SAME element ───────────
/**
 * One photo sticker: a rounded-20px ~4:3 photo wearing a thick 6px near-white border, tilted
 * alternately ±2deg, with a fully-rounded candy caption pill (backing rotates by card index, dark
 * text) BELOW the photo in the SAME element so a carousel can never split them.
 */
function photoCard(c: VocabItem, w: number, photoH: number, capFont: number, i: number): string {
  const tilt = i % 2 === 0 ? PHOTO_TILT_DEG : -PHOTO_TILT_DEG;
  return (
    `<div${cardSlotAttr(c)} style="width:${w + 2 * PHOTO_BORDER}px;display:flex;` +
    `flex-direction:column;align-items:center;transform:rotate(${tilt}deg)">` +
    `<div style="width:${w}px;height:${photoH}px;border-radius:${PHOTO_RADIUS}px;` +
    `border:${PHOTO_BORDER}px solid var(--color-text);background:var(--color-surface-strong);` +
    `position:relative;overflow:hidden">` +
    imgPlaceholder(c, "position:absolute;inset:0;width:100%;height:100%;object-fit:cover") +
    `</div>` +
    `<div style="margin-top:8px;max-width:100%;background:${captionBg(i)};color:var(--color-bg);` +
    `border-radius:999px;padding:3px 14px;font-size:${capFont}px;font-weight:700;` +
    `line-height:${ROW_LINE};letter-spacing:0.5px;text-transform:uppercase;white-space:nowrap;` +
    `overflow:hidden;text-overflow:ellipsis">${esc(c.name)}</div>` +
    `</div>`
  );
}

/** Photo height that fills `bandHeight`: caption pill + gap + border + tilt/centering slack removed. */
function fitPhotoH(bandHeight: number, capFont: number): number {
  return Math.max(120, bandHeight - captionH(capFont) - 8 - 2 * PHOTO_BORDER - BAND_SLACK);
}

/** Card renderer at the fixed ~4:3 ratio (band growth scales the sticker, keeping the aspect). */
function renderCardAt(r: Register, bandHeight: number): (c: VocabItem, i: number) => string {
  const capFont = r.captionFont;
  const photoH = fitPhotoH(bandHeight, capFont);
  const w = Math.round(photoH * PHOTO_RATIO);
  return (c, i) => photoCard(c, w, photoH, capFont, i);
}

// ── stage decoration: film grain + tiny candy sparkles (inline SVG, palette-only) ────────────────
/**
 * The film-grain overlay covering the whole canvas: inline SVG fractalNoise at opacity ≤ 0.04
 * (identity demands the grain; the `z-index:1` lifts it over the positioned sticker cards so it
 * reads as one printed surface — far too faint to muddy text, which QA samples for contrast).
 */
function grainOverlay(): string {
  return (
    `<svg style="position:absolute;inset:0;width:100%;height:100%;opacity:${GRAIN_OPACITY};` +
    `z-index:1;pointer-events:none" preserveAspectRatio="none">` +
    `<filter id="grain"><feTurbulence type="fractalNoise" baseFrequency="0.9" ` +
    `numOctaves="2"></feTurbulence></filter>` +
    `<rect width="100%" height="100%" filter="url(#grain)"></rect></svg>`
  );
}

/** The 4-point sparkle path (24×24 viewBox) shared by the flourish + margin sparkles. */
const SPARKLE_PATH =
  "M12 0C13.4 7.2 16.8 10.6 24 12C16.8 13.4 13.4 16.8 12 24C10.6 16.8 7.2 13.4 0 12" +
  "C7.2 10.6 10.6 7.2 12 0Z";

/** One tiny sparkle pinned in a stage margin (decoration only, D74: no copy). */
const sparkle = (pos: string, size: number, fill: string): string =>
  `<svg style="position:absolute;${pos}" width="${size}" height="${size}" viewBox="0 0 24 24">` +
  `<path d="${SPARKLE_PATH}" fill="${fill}"></path></svg>`;

/** The small sparkle flourish riding next to the screen title (inline, not absolute). */
const titleSparkle = (size: number): string =>
  `<svg style="flex:none" width="${size}" height="${size}" viewBox="0 0 24 24">` +
  `<path d="${SPARKLE_PATH}" fill="var(--color-price)"></path></svg>`;

/** 3–4 tiny sparkles scattered in the stage margins, clear of every card. */
function stageSparkles(portrait: boolean): string {
  if (portrait) {
    return (
      sparkle("top:170px;right:16px", 24, "var(--color-accent)") +
      sparkle("top:560px;left:10px", 18, "var(--color-accent-strong)") +
      sparkle("bottom:430px;right:12px", 20, "var(--color-price)") +
      sparkle(`bottom:8px;left:${PAD_SIDE}px`, 16, "var(--color-accent-strong)")
    );
  }
  return (
    sparkle("top:420px;left:5px", 16, "var(--color-accent-strong)") +
    sparkle("bottom:3px;left:70px", 16, "var(--color-accent)") +
    sparkle("bottom:3px;right:70px", 14, "var(--color-price)")
  );
}

// ── header: ONE compact row — sparkle + Anton near-white title, tagline, logo on a rounded chip ──
function header(
  title: string,
  tagline: string | null,
  brand: ShellArgs["brand"],
  canvas: VocabCanvas,
): string {
  const portrait = canvas.height > canvas.width;
  const h = headerH(canvas);
  const size = shrinkToFitPx(title, portrait ? 66 : 50, 15, portrait ? 30 : 26);
  const tag = tagline
    ? `<div style="font-size:14px;font-weight:600;letter-spacing:3px;color:var(--color-muted);` +
      `text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;` +
      `margin-top:5px">${esc(tagline)}</div>`
    : "";
  // The logo rides a ROUNDED surface chip; no brand → a rounded bordered placeholder box.
  const logo =
    brand !== undefined
      ? `<span style="flex:none;display:flex;align-items:center;background:var(--color-surface);` +
        `border-radius:18px;padding:9px 14px">` +
        brandLogoPlaceholder(brand.name ?? "", "height:40px;max-width:170px;object-fit:contain") +
        `</span>`
      : `<div style="flex:none;width:150px;height:44px;border-radius:16px;` +
        `border:3px solid var(--color-surface-strong)"></div>`;
  return (
    `<header style="height:${h}px;flex:none;display:flex;align-items:center;` +
    `justify-content:space-between;gap:24px;padding:0 ${PAD_SIDE}px;overflow:hidden">` +
    `<div style="min-width:0;display:flex;align-items:center;gap:14px">` +
    titleSparkle(portrait ? 26 : 22) +
    `<div style="min-width:0">` +
    `<div style="font-family:'Anton',sans-serif;font-size:${size}px;line-height:1.05;` +
    `text-transform:uppercase;letter-spacing:2px;color:var(--color-text);white-space:nowrap;` +
    `overflow:hidden;text-overflow:ellipsis">${esc(title)}</div>` +
    tag +
    `</div>` +
    `</div>` +
    logo +
    `</header>`
  );
}

// ── the vocabulary ───────────────────────────────────────────────────────────────────────────────
export const bubblegumVocabulary: ComponentVocabulary = {
  id: "bubblegum",
  version: 1,
  registerNames: ["L", "M", "S"],
  // Identity: "when a photo carousel cycles, cross-fade the photos" — one big settled card at QA.
  defaultPhotoMode: "crossfade",
  // 420 lets a packed 50-item landscape board escalate to a 4th column: the landscape sticker
  // card's interior is 1816px wide → 421px columns (the blockframe lesson, re-derived here).
  minStreamWidth: 420,
  // 22 keeps the rounded cards' stage-gap rhythm airy in a landscape column flow.
  sectionGap: 22,
  landscapeBannerHeight: 220,

  photoBandCapacity(bandWidth: number): number {
    // Stickers never smaller than the S-register 4:3 card (200px wide) + breathing room.
    const minCard = Math.round(REGISTERS.S.photoH * PHOTO_RATIO) + 24;
    return Math.max(1, Math.floor(bandWidth / minCard));
  },

  contentBox(canvas: VocabCanvas): { width: number; height: number } {
    const portrait = canvas.height > canvas.width;
    if (portrait) {
      return {
        width: canvas.width - 2 * PAD_SIDE,
        height: canvas.height - headerH(canvas) - PAD_TOP - PAD_BOTTOM,
      };
    }
    // Landscape: subtract the full-height sticker card's interior padding too, so the fitter's box
    // is exactly the interior the columns actually get (no border — the card is borderless).
    return {
      width: canvas.width - 2 * LAND_PAD_SIDE - 2 * LAND_CARD_PAD,
      height: canvas.height - headerH(canvas) - LAND_PAD_TOP - LAND_PAD_BOTTOM - 2 * LAND_CARD_PAD,
    };
  },

  metrics(register) {
    const r = registerByName(register);
    return metricsFromNumbers({
      rowHeight: rowH(r, false),
      headerHeight: pillBlockH(r, false) + cardChrome(r.cardPadV),
      smallRowHeight: rowH(r, true),
      smallHeaderHeight: pillBlockH(r, true) + cardChrome(r.memberPadV),
      photoBandHeight: photoBandH(r),
      cueHeight: cueFont(r) * ROW_LINE + 10,
      singleColumnMax: 4,
    });
  },

  renderShell(args: ShellArgs): string {
    // Root owns the page: grape stage, film grain + margin sparkles, the compact header row, then
    // the body. The SAME insets contentBox subtracts are applied here (portrait: bare margins
    // around the sticker cards; landscape: margins + ONE full-height rounded sticker card with the
    // columns inside). No token declarations, no document chrome — the renderer's wrapper declares
    // tokens.
    const portrait = args.canvas.height > args.canvas.width;
    const body = portrait
      ? `<div style="flex:1;display:flex;flex-direction:column;` +
        `padding:${PAD_TOP}px ${PAD_SIDE}px ${PAD_BOTTOM}px;min-height:0">${args.bodyHtml}</div>`
      : `<div style="flex:1;display:flex;` +
        `padding:${LAND_PAD_TOP}px ${LAND_PAD_SIDE}px ${LAND_PAD_BOTTOM}px;min-height:0">` +
        `<div style="flex:1;min-width:0;position:relative;overflow:hidden;` +
        `background:var(--color-surface);border-radius:${LAND_CARD_RADIUS}px;` +
        `padding:${LAND_CARD_PAD}px;display:flex;flex-direction:column;min-height:0">` +
        `<div style="position:absolute;top:0;left:0;right:0;height:120px;` +
        `background:linear-gradient(to bottom,${GLOSS},transparent);pointer-events:none"></div>` +
        `${args.bodyHtml}</div>` +
        `</div>`;
    return (
      `<div data-composed="bubblegum@1" style="width:${args.canvas.width}px;` +
      `height:${args.canvas.height}px;background:var(--color-bg);color:var(--color-text);` +
      `font-family:'Inter',sans-serif;position:relative;display:flex;` +
      `flex-direction:column;overflow:hidden">` +
      grainOverlay() +
      stageSparkles(portrait) +
      header(args.title, args.tagline, args.brand, args.canvas) +
      body +
      `</div>`
    );
  },

  renderSection(args) {
    const r = registerByName(args.register);
    return stickerCard(
      CARD_RADIUS,
      r.cardPadV,
      r.cardPadH,
      pillHeader(args.number, args.section.title, r, false) +
        priceList(args.section.items, args.internalCols, r, false),
    );
  },

  renderGroup(args) {
    return groupCard(args.sections, args.startNumber, registerByName(args.register));
  },

  renderPhotoBand(args) {
    const r = registerByName(args.register);
    const renderCard = renderCardAt(r, args.bandHeight);
    if (args.mode === "crossfade") {
      // The theme default: one big sticker at a time, cross-dissolving (identity's photo carousel).
      return crossfadeBand({
        items: args.items,
        bandHeight: args.bandHeight,
        uid: args.uid,
        renderCard,
      });
    }
    if (args.mode === "filmstrip") {
      // Keep the default soft edge-fade — stickers melting in/out suits the glossy candy look.
      return filmstripBand({
        items: args.items,
        bandHeight: args.bandHeight,
        uid: args.uid,
        renderCard,
      });
    }
    const inner = args.items
      .map((c, i) => `<div style="flex:none;margin:0 16px">${renderCard(c, i)}</div>`)
      .join("");
    return staticBand(args.bandHeight, inner);
  },

  renderFlowLead(args) {
    // Landscape flow lives INSIDE the big sticker card — the pill header needs no card of its own.
    const r = registerByName(args.register);
    const first = args.section.items[0];
    return (
      pillHeader(args.number, args.section.title, r, false) +
      (first ? priceRow(first, r, false) : "")
    );
  },

  renderFlowRow(args) {
    return priceRow(args.item, registerByName(args.register), false);
  },

  renderContinuationCue(args) {
    return continuationCue(args.sectionTitle, registerByName(args.register));
  },

  promptNotes: {
    section:
      "a big rounded glossy sticker card on the grape stage, opened by a fully-rounded candy pill header (coral/mint/yellow rotating by section number, dark Anton title + number chip) over Inter dotted-leader rows ending in bold sunny-yellow prices (1–2 columns, sized automatically)",
    group:
      "2–3 SMALL sections inside ONE rounded sticker card, divided by chunky rounded bars, each with a small candy pill header — use for categories of ~2–5 items",
    photoBand:
      "big rounded photo stickers with thick near-white borders, tilted alternately, each with a fully-rounded candy caption pill — cross-fading one at a time",
  },
};
