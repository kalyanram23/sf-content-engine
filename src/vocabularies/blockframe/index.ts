/**
 * The `blockframe` component vocabulary (D71/D78) — "maximalist neobrutalism, a screen-printed
 * poster wall": warm paper ground with sparse geometric margin marks (bold crosses, corner
 * brackets, a zigzag); EVERYTHING that groups content is a framed block — white cards with a 4px
 * solid ink border and a HARD offset shadow (`box-shadow:0.5rem 0.5rem 0 var(--color-text)` —
 * rem + var() only, no blur, no rgba); square corners everywhere. Sections open with a
 * candy-yellow (surface-strong) header band sitting FLUSH at the card top, Archivo Black all-caps
 * ink text and an ink-bordered number chip; rows are Space Grotesk names over a dotted leader
 * into bold tabular prices. Photo cards are ink-bordered blocks with a solid ink caption panel.
 * On a landscape canvas the WHOLE body lives inside one full-height bordered+shadowed white card
 * (columns + rules inside it); portrait stacks the section cards directly on paper. Hot pink
 * accents appear ONLY as small decoration marks — never as invented copy (D74).
 *
 * Built on the shared toolbox (src/vocabularies/shared/) — binding/escaping, carousel mechanics,
 * register math and masthead sizing live there; this file holds only blockframe's visual language.
 * Engine-legal output: one `data-composed="blockframe@1"` root, tokens as `var(--color-*)` only,
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
  bindPrice,
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
const CARD_BORDER = 4; // the ink frame every block wears
const SHADOW = 8; // the hard offset shadow (0.5rem at the packaged 16px root)
/** The one shadow every framed block casts — rem lengths + var() only (theme `do` rule). */
const HARD_SHADOW = "box-shadow:0.5rem 0.5rem 0 var(--color-text)";

// portrait: section cards sit directly on paper inside these margins
const PAD_SIDE = 48;
const PAD_TOP = 24;
const PAD_BOTTOM = 36;
// landscape: the body is ONE full-height framed card; slimmer margins keep the interior wide
// enough for 4 × minStreamWidth columns (1816px body → 421px columns).
const LAND_PAD_TOP = 16;
const LAND_PAD_SIDE = 28;
const LAND_PAD_BOTTOM = 24;
const LAND_CARD_PAD = 20;

/** Compact header band: title + thick ink rule; taller on a portrait poster. */
const headerH = (canvas: VocabCanvas): number => (canvas.height > canvas.width ? 140 : 108);

const ROW_LINE = 1.3; // rows declare this line-height INLINE, so estimates match the render
const BAND_LINE = 1.1; // Archivo Black header bands

/** Low-alpha inks derived from the theme's TEXT token (token-pure; no raw hex). */
const LEADER = "color-mix(in srgb,var(--color-text) 35%,transparent)";
const RULE_SOFT = "color-mix(in srgb,var(--color-text) 25%,transparent)";

// ── registers ────────────────────────────────────────────────────────────────────────────────────
type RegisterName = "L" | "M" | "S";

interface Register {
  name: RegisterName;
  bandFont: number; // Archivo Black section-band title
  bandPadV: number;
  chipFont: number; // ink-bordered number chip in the band
  rowName: number;
  rowPad: number;
  colGap: number;
  cardPadV: number; // rows-area padding inside the section card
  cardPadH: number;
  smBandFont: number; // group-member (small) variants
  smBandPadV: number;
  smRowName: number;
  smRowPad: number;
  memberPadV: number;
  cardPhotoH: number; // photo block interior height
  cardW: number; // photo card total width at cardPhotoH (fixed per-register ratio)
  captionFont: number;
}

const REGISTERS: Record<RegisterName, Register> = {
  L: {
    name: "L",
    bandFont: 32,
    bandPadV: 12,
    chipFont: 15,
    rowName: 22,
    rowPad: 6,
    colGap: 48,
    cardPadV: 18,
    cardPadH: 22,
    smBandFont: 22,
    smBandPadV: 8,
    smRowName: 19,
    smRowPad: 5,
    memberPadV: 14,
    cardPhotoH: 230,
    cardW: 315,
    captionFont: 18,
  },
  M: {
    name: "M",
    bandFont: 26,
    bandPadV: 10,
    chipFont: 13,
    rowName: 19,
    rowPad: 4,
    colGap: 40,
    cardPadV: 16,
    cardPadH: 20,
    smBandFont: 19,
    smBandPadV: 7,
    smRowName: 17,
    smRowPad: 3,
    memberPadV: 12,
    cardPhotoH: 200,
    cardW: 275,
    captionFont: 16,
  },
  S: {
    name: "S",
    bandFont: 21,
    bandPadV: 8,
    chipFont: 11,
    rowName: 16,
    rowPad: 3,
    colGap: 32,
    cardPadV: 12,
    cardPadH: 16,
    smBandFont: 16,
    smBandPadV: 6,
    smRowName: 15,
    smRowPad: 3,
    memberPadV: 10,
    cardPhotoH: 170,
    cardW: 235,
    captionFont: 14,
  },
};

const registerByName = (name: string): Register => REGISTERS[name as RegisterName] ?? REGISTERS.M;

// ── metric arithmetic (fit estimates; the landscape pass measures for real) ─────────────────────
const rowH = (r: Register, small: boolean): number =>
  (small ? r.smRowName : r.rowName) * ROW_LINE + (small ? r.smRowPad : r.rowPad) * 2;
/** The yellow band's own height: title line + vertical padding + its ink rule below. */
const bandH = (r: Register, small: boolean): number =>
  (small ? r.smBandFont : r.bandFont) * BAND_LINE +
  (small ? r.smBandPadV : r.bandPadV) * 2 +
  (small ? 3 : 4);
/** Everything a framed card adds around its rows: borders + shadow offset + rows-area padding. */
const cardChrome = (padV: number): number => 2 * CARD_BORDER + SHADOW + 2 * padV;
const captionBandH = (capFont: number): number => Math.round(capFont * ROW_LINE) + 12;
/** Photo band: framed photo block + ink caption + borders + centering slack (shadow included). */
const photoBandH = (r: Register): number =>
  r.cardPhotoH + captionBandH(r.captionFont) + 2 * CARD_BORDER + SHADOW + 8;
const cueFont = (r: Register): number => Math.max(13, Math.round(r.bandFont * 0.5));

// ── the framed card + candy-yellow band header ───────────────────────────────────────────────────
/** One white framed block — 4px ink border + the hard offset shadow. Square corners. */
const framedCard = (inner: string): string =>
  `<div style="background:var(--color-surface);border:${CARD_BORDER}px solid var(--color-text);` +
  `${HARD_SHADOW}">${inner}</div>`;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * The candy-yellow header band, FLUSH at the card top (no overlap — saves height): ink-bordered
 * number chip + Archivo Black all-caps title + a tiny pink corner square (decoration only, D74).
 */
function bandHeader(n: number, title: string, r: Register, small = false): string {
  const font = small ? r.smBandFont : r.bandFont;
  const padV = small ? r.smBandPadV : r.bandPadV;
  const rule = small ? 3 : 4;
  const chip =
    `<span style="flex:none;border:3px solid var(--color-text);padding:1px 7px;` +
    `font-family:'Space Grotesk',sans-serif;font-size:${r.chipFont}px;font-weight:700;` +
    `line-height:${ROW_LINE}">${pad2(n)}</span>`;
  const accent = small
    ? ""
    : `<span style="position:absolute;top:0;right:0;width:10px;height:10px;background:var(--color-accent)"></span>`;
  return (
    `<div style="position:relative;display:flex;align-items:center;gap:${small ? 8 : 12}px;` +
    `background:var(--color-surface-strong);border-bottom:${rule}px solid var(--color-text);` +
    `padding:${padV}px ${small ? 12 : 16}px">` +
    chip +
    `<span style="font-family:'Archivo Black',sans-serif;font-size:${font}px;line-height:${BAND_LINE};` +
    `text-transform:uppercase;letter-spacing:1px;color:var(--color-text);min-width:0;` +
    `white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(title)}</span>` +
    accent +
    `</div>`
  );
}

/** Landscape flow lead band: the same yellow band, fully ink-bordered (it sits on the body card). */
function flowBand(n: number, title: string, r: Register): string {
  return (
    `<div style="display:flex;align-items:center;gap:10px;background:var(--color-surface-strong);` +
    `border:3px solid var(--color-text);padding:${r.bandPadV - 2}px 12px;margin-bottom:10px">` +
    `<span style="flex:none;border:3px solid var(--color-text);padding:1px 7px;` +
    `font-family:'Space Grotesk',sans-serif;font-size:${r.chipFont}px;font-weight:700;` +
    `line-height:${ROW_LINE}">${pad2(n)}</span>` +
    `<span style="font-family:'Archivo Black',sans-serif;font-size:${r.bandFont}px;line-height:${BAND_LINE};` +
    `text-transform:uppercase;letter-spacing:1px;color:var(--color-text);min-width:0;` +
    `white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(title)}</span>` +
    `</div>`
  );
}

/** Continuation cue at a spilled landscape column top: muted italic, band-less, thin soft rule. */
function continuationCue(title: string, r: Register): string {
  const size = cueFont(r);
  return (
    `<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:8px">` +
    `<span style="font-size:${size}px;font-weight:600;font-style:italic;line-height:${ROW_LINE};` +
    `color:var(--color-muted)">${esc(title)} (cont.)</span>` +
    `<span style="flex:1;border-bottom:1px solid ${RULE_SOFT};transform:translateY(-4px)"></span>` +
    `</div>`
  );
}

// ── price rows: Space Grotesk name → dotted leader → bold tabular price ─────────────────────────
function priceRow(item: VocabItem, r: Register, small: boolean): string {
  const nameSize = small ? r.smRowName : r.rowName;
  const pad = small ? r.smRowPad : r.rowPad;
  const priceHtml =
    item.price === null
      ? bindPrice(
          "MP",
          `font-size:${Math.round(nameSize * 0.7)}px;font-weight:700;color:var(--color-price);` +
            `border:2px solid var(--color-price);padding:0 6px`,
        )
      : bindPrice(
          money(item.price),
          `font-size:${nameSize}px;font-weight:700;color:var(--color-price);font-variant-numeric:tabular-nums`,
        );
  // line-height is declared HERE (inherited by the name/price spans) so the rendered row height is
  // exactly the metric estimate — independent of the packaged root's preflight line-height.
  return bindRow(
    item,
    `display:flex;align-items:baseline;gap:10px;padding:${pad}px 0;line-height:${ROW_LINE};` +
      `font-family:'Space Grotesk',sans-serif`,
    `<span style="font-size:${nameSize}px;font-weight:600">${esc(item.name)}</span>` +
      `<span style="flex:1;border-bottom:2px dotted ${LEADER};transform:translateY(-4px)"></span>` +
      priceHtml,
  );
}

/** Rows flowing top-to-bottom then across `columns` (1–3) inside the card's rows area. */
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

// ── group: 2–3 small sections INSIDE one shared framed card, split by ink rules ──────────────────
function groupCard(sections: VocabSection[], startNumber: number, r: Register): string {
  const n = sections.length;
  const template = Array(n).fill("1fr").join(" ");
  const cols = sections
    .map((sec, i) => {
      const divider = i === 0 ? "" : "border-left:2px solid var(--color-text);";
      return (
        `<div style="${divider}display:flex;flex-direction:column;min-width:0">` +
        bandHeader(startNumber + i, sec.title, r, true) +
        `<div style="padding:${r.memberPadV}px 14px">` +
        priceList(sec.items, 1, r, true) +
        `</div>` +
        `</div>`
      );
    })
    .join("");
  return framedCard(`<div style="display:grid;grid-template-columns:${template}">${cols}</div>`);
}

// ── photo cards: ink-framed photo block + solid ink caption panel ────────────────────────────────
/**
 * One photo block: the photo inside a 4px ink border with the hard offset shadow, caption on a
 * SOLID INK panel below (paper text, Space Grotesk bold uppercase). Photo + caption live in ONE
 * element so a carousel can never split them.
 */
function photoCard(c: VocabItem, w: number, photoH: number, capFont: number): string {
  return (
    `<div${cardSlotAttr(c)} style="width:${w}px;background:var(--color-surface);` +
    `border:${CARD_BORDER}px solid var(--color-text);${HARD_SHADOW}">` +
    `<div style="height:${photoH}px;position:relative;overflow:hidden">` +
    imgPlaceholder(c, "position:absolute;inset:0;width:100%;height:100%;object-fit:cover") +
    `</div>` +
    `<div style="background:var(--color-text);color:var(--color-bg);font-family:'Space Grotesk',sans-serif;` +
    `font-size:${capFont}px;font-weight:700;line-height:${ROW_LINE};letter-spacing:1px;` +
    `text-transform:uppercase;text-align:center;padding:6px 8px;white-space:nowrap;overflow:hidden;` +
    `text-overflow:ellipsis">${esc(c.name)}</div>` +
    `</div>`
  );
}

/**
 * Photo height that makes a card fill `bandHeight` with the shadow offset FULLY inside the band:
 * centering leaves (borders' complement)/2 = 8px above AND below the card, so the 8px hard shadow
 * never clips against the band's overflow:hidden.
 */
function fitPhotoH(bandHeight: number, capFont: number): number {
  return Math.max(120, bandHeight - 2 * CARD_BORDER - captionBandH(capFont) - (SHADOW + 8));
}

/** Card renderer at a fixed per-register width:photo-height ratio (sparse growth keeps aspect). */
function renderCardAt(r: Register, bandHeight: number): (c: VocabItem, i: number) => string {
  const capFont = r.captionFont;
  const photoH = fitPhotoH(bandHeight, capFont);
  const w = Math.round(photoH * (r.cardW / r.cardPhotoH));
  return (c) => photoCard(c, w, photoH, capFont);
}

// ── margin marks: sparse geometric punctuation, inline SVG in theme inks (never raw hex) ────────
/** A thick ink corner bracket (border-top/left, flipped into position via transform). */
const bracket = (pos: string): string =>
  `<div style="position:absolute;${pos};width:26px;height:26px;` +
  `border-top:4px solid var(--color-text);border-left:4px solid var(--color-text)"></div>`;

/** A bold cross in the hot-pink accent — the one loud accent mark per board (D74: no copy). */
const cross = (pos: string): string =>
  `<svg style="position:absolute;${pos}" width="24" height="24" viewBox="0 0 24 24">` +
  `<path d="M10 1h4v9h9v4h-9v9h-4v-9H1v-4h9z" fill="var(--color-accent)"></path></svg>`;

/** A hard-edged ink zigzag, horizontal (portrait bottom margin). */
const zigzagH = (pos: string): string =>
  `<svg style="position:absolute;${pos}" width="46" height="14" viewBox="0 0 46 14">` +
  `<polyline points="2,12 9,2 16,12 23,2 30,12 37,2 44,12" fill="none" ` +
  `stroke="var(--color-text)" stroke-width="3"></polyline></svg>`;

/** The same zigzag turned vertical (landscape left margin, where the bottom margin is slim). */
const zigzagV = (pos: string): string =>
  `<svg style="position:absolute;${pos}" width="14" height="46" viewBox="0 0 14 46">` +
  `<polyline points="12,2 2,9 12,16 2,23 12,30 2,37 12,44" fill="none" ` +
  `stroke="var(--color-text)" stroke-width="3"></polyline></svg>`;

function marginMarks(portrait: boolean): string {
  if (portrait) {
    return (
      bracket("top:12px;left:12px") +
      cross("top:14px;right:16px") +
      zigzagH("bottom:10px;left:16px") +
      bracket("bottom:12px;right:12px;transform:scale(-1,-1)")
    );
  }
  // Landscape margins are slim; keep the marks to the header corners + the left margin.
  return (
    bracket("top:10px;left:10px") + cross("top:12px;right:14px") + zigzagV("left:8px;bottom:110px")
  );
}

// ── header: Archivo Black all-caps title, thick ink rule below, logo right ───────────────────────
function header(
  title: string,
  tagline: string | null,
  brand: ShellArgs["brand"],
  canvas: VocabCanvas,
): string {
  const portrait = canvas.height > canvas.width;
  const h = headerH(canvas);
  const size = shrinkToFitPx(title, portrait ? 62 : 46, 15, portrait ? 30 : 26);
  const tag = tagline
    ? `<div style="font-size:13px;font-weight:700;letter-spacing:3px;color:var(--color-muted);` +
      `text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;` +
      `margin-top:6px">${esc(tagline)}</div>`
    : "";
  const logo =
    brand !== undefined
      ? brandLogoPlaceholder(
          brand.name ?? "",
          "height:48px;max-width:180px;object-fit:contain;flex:none",
        )
      : `<div style="flex:none;width:150px;height:44px;background:var(--color-surface);` +
        `border:3px solid var(--color-text);box-shadow:0.25rem 0.25rem 0 var(--color-text)"></div>`;
  return (
    `<header style="height:${h}px;flex:none;display:flex;align-items:center;` +
    `justify-content:space-between;gap:24px;padding:0 52px;` +
    `border-bottom:6px solid var(--color-text);overflow:hidden">` +
    `<div style="min-width:0">` +
    `<div style="font-family:'Archivo Black',sans-serif;font-size:${size}px;line-height:1.05;` +
    `text-transform:uppercase;letter-spacing:1px;color:var(--color-text);white-space:nowrap;` +
    `overflow:hidden;text-overflow:ellipsis">${esc(title)}</div>` +
    tag +
    `</div>` +
    logo +
    `</header>`
  );
}

// ── the vocabulary ───────────────────────────────────────────────────────────────────────────────
export const blockframeVocabulary: ComponentVocabulary = {
  id: "blockframe",
  version: 1,
  registerNames: ["L", "M", "S"],
  defaultPhotoMode: "filmstrip",
  // 420 lets a packed 50-item landscape board escalate to a 4th column: the framed landscape body
  // is 1816px wide → 421px columns (the bold-poster lesson, re-derived for the card-wrapped body).
  minStreamWidth: 420,
  // 24 keeps a card's 8px hard shadow clear of the next section in a landscape column.
  sectionGap: 24,
  landscapeBannerHeight: 216,

  photoBandCapacity(bandWidth: number): number {
    // Cards never narrower than the S-register photo block; bigger registers scale in the count.
    return Math.max(1, Math.floor(bandWidth / REGISTERS.S.cardW));
  },

  contentBox(canvas: VocabCanvas): { width: number; height: number } {
    const portrait = canvas.height > canvas.width;
    if (portrait) {
      return {
        width: canvas.width - 2 * PAD_SIDE,
        height: canvas.height - headerH(canvas) - PAD_TOP - PAD_BOTTOM,
      };
    }
    // Landscape: subtract the full-height body card's border + interior padding too, so the
    // fitter's box is exactly the interior the columns actually get.
    return {
      width: canvas.width - 2 * LAND_PAD_SIDE - 2 * CARD_BORDER - 2 * LAND_CARD_PAD,
      height:
        canvas.height -
        headerH(canvas) -
        LAND_PAD_TOP -
        LAND_PAD_BOTTOM -
        2 * CARD_BORDER -
        2 * LAND_CARD_PAD,
    };
  },

  metrics(register) {
    const r = registerByName(register);
    return metricsFromNumbers({
      rowHeight: rowH(r, false),
      headerHeight: bandH(r, false) + cardChrome(r.cardPadV),
      smallRowHeight: rowH(r, true),
      smallHeaderHeight: bandH(r, true) + cardChrome(r.memberPadV),
      photoBandHeight: photoBandH(r),
      cueHeight: cueFont(r) * ROW_LINE + 10,
      singleColumnMax: 4,
    });
  },

  renderShell(args: ShellArgs): string {
    // Root owns the page: warm paper, margin marks, the header band, then the body. The SAME
    // insets contentBox subtracts are applied here (portrait: bare margins; landscape: margins +
    // the full-height framed card, its 8px shadow reserved inside the margins so nothing clips).
    // No token declarations, no document chrome — the renderer's wrapper declares tokens.
    const portrait = args.canvas.height > args.canvas.width;
    const body = portrait
      ? `<div style="flex:1;display:flex;flex-direction:column;` +
        `padding:${PAD_TOP}px ${PAD_SIDE}px ${PAD_BOTTOM}px;min-height:0">${args.bodyHtml}</div>`
      : `<div style="flex:1;display:flex;` +
        `padding:${LAND_PAD_TOP}px ${LAND_PAD_SIDE}px ${LAND_PAD_BOTTOM}px;min-height:0">` +
        `<div style="flex:1;min-width:0;background:var(--color-surface);` +
        `border:${CARD_BORDER}px solid var(--color-text);${HARD_SHADOW};` +
        `padding:${LAND_CARD_PAD}px;display:flex;flex-direction:column;min-height:0;` +
        `overflow:hidden">${args.bodyHtml}</div>` +
        `</div>`;
    return (
      `<div data-composed="blockframe@1" style="width:${args.canvas.width}px;` +
      `height:${args.canvas.height}px;background:var(--color-bg);color:var(--color-text);` +
      `font-family:'Space Grotesk',sans-serif;position:relative;display:flex;` +
      `flex-direction:column;overflow:hidden">` +
      marginMarks(portrait) +
      header(args.title, args.tagline, args.brand, args.canvas) +
      body +
      `</div>`
    );
  },

  renderSection(args) {
    const r = registerByName(args.register);
    return framedCard(
      bandHeader(args.number, args.section.title, r, false) +
        `<div style="padding:${r.cardPadV}px ${r.cardPadH}px">` +
        priceList(args.section.items, args.internalCols, r, false) +
        `</div>`,
    );
  },

  renderGroup(args) {
    return groupCard(args.sections, args.startNumber, registerByName(args.register));
  },

  renderPhotoBand(args) {
    const r = registerByName(args.register);
    const renderCard = renderCardAt(r, args.bandHeight);
    if (args.mode === "crossfade") {
      return crossfadeBand({
        items: args.items,
        bandHeight: args.bandHeight,
        uid: args.uid,
        renderCard,
      });
    }
    if (args.mode === "filmstrip") {
      return filmstripBand({
        items: args.items,
        bandHeight: args.bandHeight,
        uid: args.uid,
        renderCard,
        // Hard-clip the strip edges: the default soft edge-fade is a translucency gradient, which
        // the identity forbids ("no gradients or translucency") — cards cut off like a print crop.
        edgeFade: false,
      });
    }
    const inner = args.items
      .map((c, i) => `<div style="flex:none;margin:0 14px">${renderCard(c, i)}</div>`)
      .join("");
    return staticBand(args.bandHeight, inner);
  },

  renderFlowLead(args) {
    const r = registerByName(args.register);
    const first = args.section.items[0];
    return flowBand(args.number, args.section.title, r) + (first ? priceRow(first, r, false) : "");
  },

  renderFlowRow(args) {
    return priceRow(args.item, registerByName(args.register), false);
  },

  renderContinuationCue(args) {
    return continuationCue(args.sectionTitle, registerByName(args.register));
  },

  promptNotes: {
    section:
      "a white framed block — 4px ink border, hard offset shadow — opened by a flush candy-yellow band (ink number chip + Archivo Black all-caps title) over dotted-leader price rows (1–2 columns, sized automatically)",
    group:
      "2–3 SMALL sections sharing ONE framed block, split by ink rules, each with a small yellow band header — use for categories of ~2–5 items",
    photoBand:
      "a filmstrip of ink-framed photo blocks with hard offset shadows and solid ink caption panels",
  },
};
