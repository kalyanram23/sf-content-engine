/**
 * The `bazaar` component vocabulary (D71/D78) — "BAZAAR POP: Indian street bazaar meets modern gig
 * poster, hand-pasted": a hot-orange ground with sparse cream dot texture where ALL menu content
 * lives on cream poster panels — 5px solid ink borders, HARD offset shadows
 * (`box-shadow:0.625rem 0.625rem 0 var(--color-text)` — rem + var() only, no blur, no rgba) — each
 * panel tilted a hair (even section numbers +0.8deg, odd −0.8deg, never past 1deg) like a slapped-on
 * bill. Sections open with an Anton all-caps ink title over a short thick chili-red underline and an
 * ink number chip; Archivo rows run a dotted leader into a BORDERED PRICE CHIP (2px ink border on
 * surface-strong, bold price ink). Photos are CIRCLE STICKERS: circular photos with a thick cream
 * border, a 3px ink outline ring plus the hard offset shadow, tilted alternately ±2deg, caption on a
 * small tilted cream chip in the same element; one red starburst by the first sticker. The header is
 * ONE slim compact row (cream Anton title + tagline, logo on an ink chip) — never a masthead. On a
 * landscape canvas the WHOLE body lives inside one full-height cream panel (no tilt on the big one);
 * portrait tilts the section panels directly on the orange ground. Palette: orange ground, cream,
 * ink, chili red only.
 *
 * Built on the shared toolbox (src/vocabularies/shared/) — binding/escaping, carousel mechanics,
 * register math and masthead sizing live there; this file holds only bazaar's visual language.
 * Engine-legal output: one `data-composed="bazaar@1"` root, tokens as `var(--color-*)` only,
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
const PANEL_BORDER = 5; // the ink frame every poster panel wears
const SHADOW = 10; // the hard offset shadow (0.625rem at the packaged 16px root)
/** The one shadow every panel casts — rem lengths + var() only (theme `do` rule). */
const HARD_SHADOW = "box-shadow:0.625rem 0.625rem 0 var(--color-text)";
/** Circle stickers: a 3px ink outline RING (zero blur — an outline, not a glow) + the hard offset. */
const STICKER_SHADOW = "box-shadow:0 0 0 3px var(--color-text),0.5rem 0.5rem 0 var(--color-text)";
/** Panel tilt: even section numbers lean right, odd lean left — never more than 1deg (theme dont). */
const TILT_DEG = 0.8;
/** Metric slack per panel: the tilted bounding box + a hair of breathing room (≈992px × sin 0.8°). */
const TILT_SLACK = 16;

// portrait: section panels sit directly on the orange ground inside these margins
const PAD_SIDE = 44;
const PAD_TOP = 24;
const PAD_BOTTOM = 36;
// landscape: the body is ONE full-height cream panel; slim margins keep the interior wide enough
// for 4 × minStreamWidth columns (1814px body → 420px columns).
const LAND_PAD_TOP = 16;
const LAND_PAD_SIDE = 26;
const LAND_PAD_BOTTOM = 22;
const LAND_PANEL_PAD = 22;

/** ONE slim compact header row — identity caps it at ~a tenth of the canvas, never a masthead. */
const headerH = (canvas: VocabCanvas): number => (canvas.height > canvas.width ? 150 : 104);

const ROW_LINE = 1.3; // rows declare this line-height INLINE, so estimates match the render
const TITLE_LINE = 1.1; // Anton headers

/** Low-alpha inks — always via color-mix over a token (token-pure; no raw hex, no rgba literals). */
const LEADER = "color-mix(in srgb,var(--color-text) 35%,transparent)";
const RULE_SOFT = "color-mix(in srgb,var(--color-text) 25%,transparent)";
const CREAM_SOFT = "color-mix(in srgb,var(--color-surface) 80%,transparent)";
const DOT_INK = "color-mix(in srgb,var(--color-surface) 30%,transparent)";

// ── registers ────────────────────────────────────────────────────────────────────────────────────
type RegisterName = "L" | "M" | "S";

interface Register {
  name: RegisterName;
  titleFont: number; // Anton section header
  chipFont: number; // ink number chip in the header
  rowName: number; // Archivo item name
  rowPad: number;
  colGap: number;
  panelPadV: number; // interior padding of a section panel
  panelPadH: number;
  smTitle: number; // group-member (small) variants
  smRowName: number;
  smRowPad: number;
  memberPadV: number;
  stickerD: number; // base circle-sticker diameter (band grows it; 1:1 keeps the circle)
  captionFont: number;
}

const REGISTERS: Record<RegisterName, Register> = {
  L: {
    name: "L",
    titleFont: 34,
    chipFont: 14,
    rowName: 22,
    rowPad: 6,
    colGap: 48,
    panelPadV: 20,
    panelPadH: 26,
    smTitle: 22,
    smRowName: 19,
    smRowPad: 5,
    memberPadV: 16,
    stickerD: 210,
    captionFont: 17,
  },
  M: {
    name: "M",
    titleFont: 28,
    chipFont: 12,
    rowName: 19,
    rowPad: 4,
    colGap: 40,
    panelPadV: 18,
    panelPadH: 22,
    smTitle: 19,
    smRowName: 17,
    smRowPad: 4,
    memberPadV: 13,
    stickerD: 180,
    captionFont: 15,
  },
  S: {
    name: "S",
    titleFont: 22,
    chipFont: 11,
    rowName: 16,
    rowPad: 3,
    colGap: 32,
    panelPadV: 14,
    panelPadH: 18,
    smTitle: 16,
    smRowName: 15,
    smRowPad: 3,
    memberPadV: 10,
    stickerD: 150,
    captionFont: 13,
  },
};

const registerByName = (name: string): Register => REGISTERS[name as RegisterName] ?? REGISTERS.M;

// ── metric arithmetic (fit estimates; the landscape pass measures for real) ─────────────────────
const priceFont = (nameSize: number): number => Math.round(nameSize * 0.82);
/** The bordered price chip's box: price line + 2px vertical padding + 2×2px ink border. */
const chipBoxH = (nameSize: number): number => Math.round(priceFont(nameSize) * ROW_LINE) + 6;
/** A row is as tall as its taller half: the name line or the bordered chip. */
const rowH = (r: Register, small: boolean): number => {
  const nameSize = small ? r.smRowName : r.rowName;
  const pad = small ? r.smRowPad : r.rowPad;
  return Math.max(nameSize * ROW_LINE, chipBoxH(nameSize)) + pad * 2;
};
/** The in-panel header block: Anton title line + gap + red underline + margin before the rows. */
const headerBlockH = (r: Register, small: boolean): number =>
  (small ? r.smTitle : r.titleFont) * TITLE_LINE + 7 + (small ? 4 : 6) + (small ? 10 : 12);
/** Everything a tilted panel adds around its rows: border + shadow + padding + tilt bbox slack. */
const panelChrome = (padV: number): number => 2 * PANEL_BORDER + SHADOW + 2 * padV + TILT_SLACK;
const captionH = (capFont: number): number => Math.round(capFont * ROW_LINE) + 10;
/** Ring + offset shadow + tilt spill + centering slack a sticker needs inside its band. */
const BAND_SLACK = 24;
const photoBandH = (r: Register): number => r.stickerD + 8 + captionH(r.captionFont) + BAND_SLACK;
const cueFont = (r: Register): number => Math.max(13, Math.round(r.titleFont * 0.5));

// ── the tilted cream panel ───────────────────────────────────────────────────────────────────────
/** Alternating hand-pasted tilt, deterministic from the section number (even +, odd −). */
const tiltFor = (n: number): string => `rotate(${n % 2 === 0 ? "" : "-"}${TILT_DEG}deg)`;

/** One cream poster panel — 5px ink border + the hard offset shadow, tilted by section parity. */
const panel = (n: number, padV: number, padH: number, inner: string): string =>
  `<div style="background:var(--color-surface);border:${PANEL_BORDER}px solid var(--color-text);` +
  `${HARD_SHADOW};transform:${tiltFor(n)};padding:${padV}px ${padH}px">${inner}</div>`;

const pad2 = (n: number): string => String(n).padStart(2, "0");

/**
 * The in-panel header: small ink number chip + Anton all-caps ink title, then the short thick
 * chili-red underline bar (90×6px full / 60×4px small).
 */
function headerBlock(n: number, title: string, r: Register, small = false): string {
  const font = small ? r.smTitle : r.titleFont;
  const chipFont = small ? Math.max(9, r.chipFont - 2) : r.chipFont;
  const bar = small ? "width:60px;height:4px" : "width:90px;height:6px";
  const mb = small ? 10 : 12;
  return (
    `<div style="display:flex;align-items:center;gap:10px">` +
    `<span style="flex:none;background:var(--color-text);color:var(--color-surface);` +
    `font-size:${chipFont}px;font-weight:700;line-height:${ROW_LINE};padding:2px 8px">${pad2(n)}</span>` +
    `<span style="font-family:'Anton',sans-serif;font-size:${font}px;line-height:${TITLE_LINE};` +
    `text-transform:uppercase;letter-spacing:1px;color:var(--color-text);min-width:0;` +
    `white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(title)}</span>` +
    `</div>` +
    `<div style="${bar};background:var(--color-accent);margin:7px 0 ${mb}px"></div>`
  );
}

/** Continuation cue at a spilled landscape column top: Archivo bold italic, muted, soft rule. */
function continuationCue(title: string, r: Register): string {
  const size = cueFont(r);
  return (
    `<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:8px">` +
    `<span style="font-size:${size}px;font-weight:700;font-style:italic;line-height:${ROW_LINE};` +
    `color:var(--color-muted)">${esc(title)} (cont.)</span>` +
    `<span style="flex:1;border-bottom:1px solid ${RULE_SOFT};transform:translateY(-4px)"></span>` +
    `</div>`
  );
}

// ── price rows: Archivo name → dotted leader → BORDERED PRICE CHIP ──────────────────────────────
/** The chip IS the bind span: 2px ink border, surface-strong backing, bold price-ink text. */
const chipStyle = (font: number): string =>
  `font-size:${font}px;font-weight:700;color:var(--color-price);` +
  `background:var(--color-surface-strong);border:2px solid var(--color-text);` +
  `padding:1px 8px;line-height:${ROW_LINE};font-variant-numeric:tabular-nums;flex:none`;

function priceRow(item: VocabItem, r: Register, small: boolean): string {
  const nameSize = small ? r.smRowName : r.rowName;
  const pad = small ? r.smRowPad : r.rowPad;
  const font = priceFont(nameSize);
  // Null price → the SAME chip, marked "MP" (market price), so every chip reads as a price tag.
  const priceHtml = bindPrice(item.price === null ? "MP" : money(item.price), chipStyle(font));
  // line-height is declared HERE (inherited by the name/price spans) so the rendered row height is
  // exactly the metric estimate — independent of the packaged root's preflight line-height.
  return bindRow(
    item,
    `display:flex;align-items:baseline;gap:10px;padding:${pad}px 0;line-height:${ROW_LINE};` +
      `font-family:'Archivo',sans-serif`,
    `<span style="font-size:${nameSize}px;font-weight:500">${esc(item.name)}</span>` +
      `<span style="flex:1;border-bottom:2px dotted ${LEADER};transform:translateY(-4px)"></span>` +
      priceHtml,
  );
}

/** Rows flowing top-to-bottom then across `columns` (1–3) inside the panel. */
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

// ── group: 2–3 small sections pasted side by side inside ONE cream panel ─────────────────────────
function groupPanel(sections: VocabSection[], startNumber: number, r: Register): string {
  const n = sections.length;
  const template = Array(n).fill("1fr").join(" ");
  const cols = sections
    .map((sec, i) => {
      const divider = i === 0 ? "" : "border-left:2px solid var(--color-text);";
      const padSide =
        i === 0 ? "padding-right:18px" : i === n - 1 ? "padding-left:18px" : "padding:0 18px";
      return (
        `<div style="${divider}${padSide};min-width:0">` +
        headerBlock(startNumber + i, sec.title, r, true) +
        priceList(sec.items, 1, r, true) +
        `</div>`
      );
    })
    .join("");
  // ONE border + ONE shadow for the whole band; the tilt follows the first member's number.
  return panel(
    startNumber,
    r.memberPadV,
    16,
    `<div style="display:grid;grid-template-columns:${template}">${cols}</div>`,
  );
}

// ── circle photo stickers ────────────────────────────────────────────────────────────────────────
/** A small red starburst (decoration only, D74: no copy) pinned by the FIRST sticker. */
function starburst(size: number): string {
  const pts = Array.from({ length: 16 }, (_, i) => {
    const rr = i % 2 === 0 ? 50 : 26;
    const a = (Math.PI * i) / 8;
    return `${(50 + rr * Math.cos(a)).toFixed(1)},${(50 + rr * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 100 100" ` +
    `style="position:absolute;top:-8px;left:-10px;transform:rotate(-12deg)">` +
    `<polygon points="${pts}" fill="var(--color-accent)"></polygon></svg>`
  );
}

/**
 * One circle sticker: a circular photo (1:1, diameter from the band height so growth keeps the
 * circle) wearing a thick cream border, a 3px ink outline ring + the hard offset shadow, tilted
 * alternately ±2deg; the caption rides a small counter-tilted cream chip BELOW the circle in the
 * SAME element so a carousel can never split them.
 */
function stickerCard(c: VocabItem, d: number, capFont: number, i: number): string {
  const tilt = i % 2 === 0 ? 2 : -2;
  return (
    `<div${cardSlotAttr(c)} style="position:relative;width:${d + 12}px;display:flex;` +
    `flex-direction:column;align-items:center;transform:rotate(${tilt}deg)">` +
    `<div style="width:${d}px;height:${d}px;border-radius:50%;` +
    `border:8px solid var(--color-surface);background:var(--color-surface);` +
    `${STICKER_SHADOW};position:relative;overflow:hidden">` +
    imgPlaceholder(c, "position:absolute;inset:0;width:100%;height:100%;object-fit:cover") +
    `</div>` +
    `<div style="margin-top:8px;background:var(--color-surface);border:2px solid var(--color-text);` +
    `padding:2px 10px;font-size:${capFont}px;font-weight:700;line-height:${ROW_LINE};` +
    `letter-spacing:1px;text-transform:uppercase;color:var(--color-text);max-width:100%;` +
    `white-space:nowrap;overflow:hidden;text-overflow:ellipsis;` +
    `transform:rotate(${-tilt * 0.25}deg)">${esc(c.name)}</div>` +
    (i === 0 ? starburst(44) : "") +
    `</div>`
  );
}

/** Sticker diameter that fills `bandHeight`: caption chip + gap + ring/shadow/tilt slack removed. */
function fitDiameter(bandHeight: number, capFont: number): number {
  return Math.max(96, bandHeight - captionH(capFont) - 8 - BAND_SLACK);
}

function renderCardAt(r: Register, bandHeight: number): (c: VocabItem, i: number) => string {
  const capFont = r.captionFont;
  const d = fitDiameter(bandHeight, capFont);
  return (c, i) => stickerCard(c, d, capFont, i);
}

// ── street-poster furniture: dot texture + zigzag divider (inline SVG, palette-only) ─────────────
/** A sparse cluster of cream dots at low opacity — the ground texture, never behind body text. */
function dotCluster(pos: string, cols: number, rows: number): string {
  const step = 20;
  const w = (cols - 1) * step + 8;
  const h = (rows - 1) * step + 8;
  let dots = "";
  for (let y = 0; y < rows; y++) {
    for (let x = 0; x < cols; x++) {
      dots += `<circle cx="${4 + x * step}" cy="${4 + y * step}" r="3"></circle>`;
    }
  }
  return (
    `<svg style="position:absolute;${pos};fill:${DOT_INK}" width="${w}" height="${h}" ` +
    `viewBox="0 0 ${w} ${h}">${dots}</svg>`
  );
}

/** The ONE cream zigzag divider strip, pasted right under the header band. */
function zigzagDivider(top: number, side: number): string {
  return (
    `<svg style="position:absolute;top:${top}px;left:${side}px;width:calc(100% - ${2 * side}px);` +
    `height:10px" viewBox="0 0 1200 12" preserveAspectRatio="none">` +
    `<path d="M0 10${"l12 -8l12 8".repeat(50)}" fill="none" stroke="var(--color-surface)" ` +
    `stroke-width="3"></path></svg>`
  );
}

/** Ground decoration: the zigzag under the header + sparse dot clusters in the margins. */
function groundDecor(portrait: boolean, header: number): string {
  if (portrait) {
    return (
      zigzagDivider(header + 6, PAD_SIDE) +
      dotCluster("top:560px;left:9px", 2, 7) +
      dotCluster("bottom:420px;right:9px", 2, 7) +
      dotCluster(`bottom:8px;left:${PAD_SIDE}px`, 10, 1)
    );
  }
  return zigzagDivider(header + 3, LAND_PAD_SIDE) + dotCluster("bottom:5px;left:60px", 10, 1);
}

// ── header: ONE slim compact row — cream Anton title, tagline, logo on an ink chip ───────────────
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
    ? `<div style="font-size:14px;font-weight:700;letter-spacing:3px;color:${CREAM_SOFT};` +
      `text-transform:uppercase;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;` +
      `margin-top:5px">${esc(tagline)}</div>`
    : "";
  // The logo rides a small INK chip (dark backing); no brand → a bordered cream placeholder box.
  const logo =
    brand !== undefined
      ? `<span style="flex:none;display:flex;align-items:center;background:var(--color-text);` +
        `padding:8px 12px">` +
        brandLogoPlaceholder(brand.name ?? "", "height:40px;max-width:170px;object-fit:contain") +
        `</span>`
      : `<div style="flex:none;width:150px;height:44px;border:3px solid var(--color-surface)"></div>`;
  return (
    `<header style="height:${h}px;flex:none;display:flex;align-items:center;` +
    `justify-content:space-between;gap:24px;padding:0 ${PAD_SIDE}px;overflow:hidden">` +
    `<div style="min-width:0">` +
    `<div style="font-family:'Anton',sans-serif;font-size:${size}px;line-height:1.05;` +
    `text-transform:uppercase;letter-spacing:2px;color:var(--color-surface);white-space:nowrap;` +
    `overflow:hidden;text-overflow:ellipsis">${esc(title)}</div>` +
    tag +
    `</div>` +
    logo +
    `</header>`
  );
}

// ── the vocabulary ───────────────────────────────────────────────────────────────────────────────
export const bazaarVocabulary: ComponentVocabulary = {
  id: "bazaar",
  version: 1,
  registerNames: ["L", "M", "S"],
  defaultPhotoMode: "filmstrip",
  // 420 lets a packed 50-item landscape board escalate to a 4th column: the cream landscape panel's
  // interior is 1814px wide → 420px columns (the blockframe lesson, re-derived for this chrome).
  minStreamWidth: 420,
  // 26 keeps a panel's 10px hard shadow + tilt spill clear of the next section in a column flow.
  sectionGap: 26,
  landscapeBannerHeight: 220,

  photoBandCapacity(bandWidth: number): number {
    // Stickers never smaller than the S-register circle; bigger registers scale in the count.
    return Math.max(1, Math.floor(bandWidth / (REGISTERS.S.stickerD + 26)));
  },

  contentBox(canvas: VocabCanvas): { width: number; height: number } {
    const portrait = canvas.height > canvas.width;
    if (portrait) {
      return {
        width: canvas.width - 2 * PAD_SIDE,
        height: canvas.height - headerH(canvas) - PAD_TOP - PAD_BOTTOM,
      };
    }
    // Landscape: subtract the full-height cream panel's border + interior padding too, so the
    // fitter's box is exactly the interior the columns actually get (the shadow lives in the
    // page margins — LAND_PAD_SIDE/BOTTOM ≥ SHADOW keeps it inside the canvas).
    return {
      width: canvas.width - 2 * LAND_PAD_SIDE - 2 * PANEL_BORDER - 2 * LAND_PANEL_PAD,
      height:
        canvas.height -
        headerH(canvas) -
        LAND_PAD_TOP -
        LAND_PAD_BOTTOM -
        2 * PANEL_BORDER -
        2 * LAND_PANEL_PAD,
    };
  },

  metrics(register) {
    const r = registerByName(register);
    return metricsFromNumbers({
      rowHeight: rowH(r, false),
      headerHeight: headerBlockH(r, false) + panelChrome(r.panelPadV),
      smallRowHeight: rowH(r, true),
      smallHeaderHeight: headerBlockH(r, true) + panelChrome(r.memberPadV),
      photoBandHeight: photoBandH(r),
      cueHeight: cueFont(r) * ROW_LINE + 10,
      singleColumnMax: 4,
    });
  },

  renderShell(args: ShellArgs): string {
    // Root owns the page: hot-orange ground, dot texture + zigzag, the slim header row, then the
    // body. The SAME insets contentBox subtracts are applied here (portrait: bare margins around
    // the tilted panels; landscape: margins + ONE full-height cream panel — no tilt on the big
    // one — with its 10px shadow reserved inside the margins so nothing clips). No token
    // declarations, no document chrome — the renderer's wrapper declares tokens.
    const portrait = args.canvas.height > args.canvas.width;
    const body = portrait
      ? `<div style="flex:1;display:flex;flex-direction:column;` +
        `padding:${PAD_TOP}px ${PAD_SIDE}px ${PAD_BOTTOM}px;min-height:0">${args.bodyHtml}</div>`
      : `<div style="flex:1;display:flex;` +
        `padding:${LAND_PAD_TOP}px ${LAND_PAD_SIDE}px ${LAND_PAD_BOTTOM}px;min-height:0">` +
        `<div style="flex:1;min-width:0;background:var(--color-surface);` +
        `border:${PANEL_BORDER}px solid var(--color-text);${HARD_SHADOW};` +
        `padding:${LAND_PANEL_PAD}px;display:flex;flex-direction:column;min-height:0;` +
        `overflow:hidden">${args.bodyHtml}</div>` +
        `</div>`;
    return (
      `<div data-composed="bazaar@1" style="width:${args.canvas.width}px;` +
      `height:${args.canvas.height}px;background:var(--color-bg);color:var(--color-text);` +
      `font-family:'Archivo',sans-serif;position:relative;display:flex;` +
      `flex-direction:column;overflow:hidden">` +
      groundDecor(portrait, headerH(args.canvas)) +
      header(args.title, args.tagline, args.brand, args.canvas) +
      body +
      `</div>`
    );
  },

  renderSection(args) {
    const r = registerByName(args.register);
    return panel(
      args.number,
      r.panelPadV,
      r.panelPadH,
      headerBlock(args.number, args.section.title, r, false) +
        priceList(args.section.items, args.internalCols, r, false),
    );
  },

  renderGroup(args) {
    return groupPanel(args.sections, args.startNumber, registerByName(args.register));
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
      // Keep the default soft edge-fade — stickers melting in/out fits the pasted-poster look.
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
    // Landscape flow lives INSIDE the big cream panel — the header needs no panel of its own.
    const r = registerByName(args.register);
    const first = args.section.items[0];
    return (
      headerBlock(args.number, args.section.title, r, false) +
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
      "a cream poster panel — 5px ink border, hard offset shadow, tilted a hair like a hand-pasted bill — opened by an Anton all-caps title with a short chili-red underline and ink number chip, over Archivo dotted-leader rows ending in bordered price chips (1–2 columns, sized automatically)",
    group:
      "2–3 SMALL sections pasted side by side inside ONE cream panel, split by ink rules, each with a small Anton header and red underline — use for categories of ~2–5 items",
    photoBand:
      "a strip of circle photo stickers — cream-bordered, ink-outlined, alternately tilted, each with a small caption chip, one red starburst by the first sticker",
  },
};
