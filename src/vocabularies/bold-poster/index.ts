/**
 * The `bold-poster` component vocabulary (D71/D78) — "a magazine cover turned menu": cream paper,
 * one loud editorial red, huge tilted Shrikhand masthead with double rules and corner crop marks;
 * sections open with a letterspaced red kicker ("NO. 01") above a big display headline and a thin
 * ink rule; Archivo rows run a dotted leader into bold deep-red price numerals; photos are framed
 * "cover shots" on tan panels with captions on paper below. FLAT like print — no shadows anywhere;
 * depth comes from scale and rules. Direction locked from the approved v2 mockups (2026-07-13).
 *
 * Built on the shared toolbox (src/vocabularies/shared/) — binding/escaping, carousel mechanics,
 * register math and masthead sizing live there; this file holds only bold-poster's visual language.
 * Engine-legal output: one `data-composed="bold-poster@1"` root, tokens as `var(--color-*)` only,
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
const PAD_SIDE = 48;
const PAD_TOP = 28;
const PAD_BOTTOM = 40;
/** The masthead block is editorial-tall on a portrait poster, compact on a landscape screen. */
const mastheadH = (canvas: VocabCanvas): number => (canvas.height > canvas.width ? 200 : 120);

const LINE = 1.25; // line-height factor for row-height estimates (fit estimates only)

/** Low-alpha inks derived from the theme's TEXT token (token-pure; no raw hex). */
const LEADER = "color-mix(in srgb,var(--color-text) 35%,transparent)";
const RULE_SOFT = "color-mix(in srgb,var(--color-text) 25%,transparent)";

// ── registers ────────────────────────────────────────────────────────────────────────────────────
type RegisterName = "L" | "M" | "S";

interface Register {
  name: RegisterName;
  kicker: number; // red letterspaced kicker font
  headline: number; // Shrikhand section headline font
  headerMb: number;
  rowName: number;
  rowPad: number;
  colGap: number;
  smKicker: number;
  smHeadline: number;
  smRowName: number;
  smRowPad: number;
  cardW: number; // cover-shot card total width
  cardPhotoH: number;
  captionFont: number;
}

const REGISTERS: Record<RegisterName, Register> = {
  L: {
    name: "L",
    kicker: 15,
    headline: 44,
    headerMb: 14,
    rowName: 23,
    rowPad: 7,
    colGap: 48,
    smKicker: 12,
    smHeadline: 30,
    smRowName: 20,
    smRowPad: 6,
    cardW: 340,
    cardPhotoH: 236,
    captionFont: 18,
  },
  M: {
    name: "M",
    kicker: 13,
    headline: 36,
    headerMb: 10,
    rowName: 19,
    rowPad: 4,
    colGap: 44,
    smKicker: 11,
    smHeadline: 25,
    smRowName: 18,
    smRowPad: 4,
    cardW: 300,
    cardPhotoH: 206,
    captionFont: 16,
  },
  S: {
    name: "S",
    kicker: 11,
    headline: 29,
    headerMb: 8,
    rowName: 17,
    rowPad: 3,
    colGap: 36,
    smKicker: 10,
    smHeadline: 21,
    smRowName: 16,
    smRowPad: 3,
    cardW: 258,
    cardPhotoH: 176,
    captionFont: 14,
  },
};

const registerByName = (name: string): Register => REGISTERS[name as RegisterName] ?? REGISTERS.M;

// ── metric arithmetic (fit estimates; the landscape pass measures for real) ─────────────────────
const rowH = (r: Register, small: boolean): number =>
  (small ? r.smRowName : r.rowName) * LINE + (small ? r.smRowPad : r.rowPad) * 2;
const headerH = (r: Register, small: boolean): number => {
  const kicker = small ? r.smKicker : r.kicker;
  const headline = small ? r.smHeadline : r.headline;
  const mb = small ? 8 : r.headerMb;
  // kicker line + gap + headline + rule + margin below
  return kicker * 1.2 + 6 + headline * 1.15 + 8 + mb;
};
const captionBandH = (capFont: number): number => Math.round(capFont * 1.25) + 18;
/** Tan panel padding (8) + photo + caption paper band + flat slack. */
const bandH = (r: Register): number => 16 + r.cardPhotoH + captionBandH(r.captionFont) + 8;

// ── section header: kicker over headline over thin rule ─────────────────────────────────────────
const kickerNo = (n: number): string => `NO. ${String(n).padStart(2, "0")}`;

function sectionHeader(n: number, title: string, r: Register, small = false): string {
  const kicker = small ? r.smKicker : r.kicker;
  const headline = small ? r.smHeadline : r.headline;
  const mb = small ? 8 : r.headerMb;
  return (
    `<div style="margin-bottom:${mb}px">` +
    `<div style="font-size:${kicker}px;font-weight:800;letter-spacing:4px;color:var(--color-accent-strong);` +
    `text-transform:uppercase;margin-bottom:5px">${kickerNo(n)}</div>` +
    `<div style="font-family:'Shrikhand',serif;font-size:${headline}px;line-height:1.05;color:var(--color-text)">${esc(title)}</div>` +
    `<div style="border-bottom:2px solid var(--color-text);margin-top:7px"></div>` +
    `</div>`
  );
}

/** Continuation cue at a spilled landscape column top: muted, subordinate to a real header. */
function continuationCue(title: string, r: Register): string {
  const size = Math.max(14, Math.round(r.headline * 0.5));
  return (
    `<div style="display:flex;align-items:baseline;gap:10px;margin-bottom:${r.headerMb}px">` +
    `<span style="font-size:${size}px;font-weight:700;font-style:italic;color:var(--color-muted)">${esc(title)} (cont.)</span>` +
    `<span style="flex:1;border-bottom:1px solid ${RULE_SOFT};transform:translateY(-4px)"></span>` +
    `</div>`
  );
}

// ── price rows: name → dotted leader → bold red numerals ────────────────────────────────────────
function priceRow(item: VocabItem, r: Register, small: boolean): string {
  const nameSize = small ? r.smRowName : r.rowName;
  const pad = small ? r.smRowPad : r.rowPad;
  const priceStyle = `font-size:${nameSize}px;font-weight:800;color:var(--color-price);font-variant-numeric:tabular-nums`;
  // Sized items → one span per size, each data-size tagged (spec §4); the MP chip stays distinct.
  const priceHtml =
    item.sizes !== undefined && item.sizes.length > 0
      ? bindPrices(item, priceStyle)
      : item.price === null
        ? bindPrice(
            "MP",
            `font-size:${Math.round(nameSize * 0.7)}px;font-weight:800;color:var(--color-price);` +
              `border:2px solid var(--color-price);padding:0 6px`,
          )
        : bindPrice(money(item.price), priceStyle);
  return bindRow(
    item,
    `display:flex;align-items:baseline;gap:10px;padding:${pad}px 0`,
    bindName(item.name, `font-size:${nameSize}px;font-weight:600`) +
      `<span style="flex:1;border-bottom:2px dotted ${LEADER};transform:translateY(-4px)"></span>` +
      priceHtml,
  );
}

/** Rows flowing top-to-bottom then across `columns` (1–3), like an editorial listing page. */
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

// ── group: 2–3 small sections divided by thin ink rules ─────────────────────────────────────────
function editorialBand(sections: VocabSection[], startNumber: number, r: Register): string {
  const n = sections.length;
  const template = Array(n).fill("1fr").join(" ");
  const cols = sections
    .map((sec, i) => {
      const border = i === 0 ? "" : `border-left:1px solid ${RULE_SOFT};`;
      const pad =
        i === 0 ? "padding-right:24px" : i === n - 1 ? "padding-left:24px" : "padding:0 24px";
      return (
        `<div style="${border}${pad}">` +
        sectionHeader(startNumber + i, sec.title, r, true) +
        priceList(sec.items, 1, r, true) +
        `</div>`
      );
    })
    .join("");
  return `<div style="display:grid;grid-template-columns:${template}">${cols}</div>`;
}

// ── cover-shot photo cards ───────────────────────────────────────────────────────────────────────
/** Small alternating top-offsets give the strip editorial rhythm while staying flat (no tilt). */
const OFFSETS = [0, 10, -6, 8, -10, 4, -8, 6];

/**
 * One cover shot: photo framed by a thin ink rule, sitting on a tan panel, caption on solid paper
 * below. Photo + caption live in ONE element so a carousel can never split them.
 */
function coverShotCard(
  c: VocabItem,
  w: number,
  photoH: number,
  capFont: number,
  offset: number,
): string {
  return (
    `<div${cardSlotAttr(c)} style="width:${w}px;background:var(--color-surface-strong);padding:8px;` +
    `transform:translateY(${offset}px)">` +
    `<div style="height:${photoH}px;position:relative;overflow:hidden;border:2px solid var(--color-text)">` +
    imgPlaceholder(c, "position:absolute;inset:0;width:100%;height:100%;object-fit:cover") +
    `</div>` +
    `<div style="background:var(--color-surface);text-align:center;font-size:${capFont}px;font-weight:700;` +
    `letter-spacing:1px;text-transform:uppercase;padding:6px 6px 8px;margin-top:6px;white-space:nowrap;` +
    `overflow:hidden;text-overflow:ellipsis">${esc(c.name)}</div>` +
    `</div>`
  );
}

/** Photo height that makes a card (panel padding + caption + offset slack) fill `bandHeight`. */
function fitPhotoH(bandHeight: number, capFont: number): number {
  const offsetSlack = 20;
  return Math.max(110, bandHeight - offsetSlack - 16 - 6 - captionBandH(capFont));
}

function renderCardAt(r: Register, bandHeight: number): (c: VocabItem, i: number) => string {
  const capFont = r.captionFont;
  const photoH = fitPhotoH(bandHeight, capFont);
  const w = Math.round(photoH * (r.cardW / r.cardPhotoH));
  return (c, i) => coverShotCard(c, w, photoH, capFont, OFFSETS[i % OFFSETS.length] ?? 0);
}

// ── masthead + crop marks ────────────────────────────────────────────────────────────────────────
/** A corner crop mark: two thin ink lines meeting at the page margin, print-style. */
function cropMark(pos: string): string {
  return (
    `<div style="position:absolute;${pos};width:26px;height:26px;` +
    `border-top:2px solid ${RULE_SOFT};border-left:2px solid ${RULE_SOFT}"></div>`
  );
}

/** A small tilted red starburst by the masthead — pure decoration, no invented copy (D74). */
function starburst(size: number): string {
  const pts = Array.from({ length: 16 }, (_, i) => {
    const rr = i % 2 === 0 ? 50 : 26;
    const a = (Math.PI * i) / 8;
    return `${(50 + rr * Math.cos(a)).toFixed(1)},${(50 + rr * Math.sin(a)).toFixed(1)}`;
  }).join(" ");
  return (
    `<svg width="${size}" height="${size}" viewBox="0 0 100 100" style="flex:none;transform:rotate(-8deg)">` +
    `<polygon points="${pts}" fill="var(--color-accent)"></polygon></svg>`
  );
}

function masthead(
  title: string,
  tagline: string | null,
  brand: ShellArgs["brand"],
  canvas: VocabCanvas,
): string {
  const portrait = canvas.height > canvas.width;
  const h = mastheadH(canvas);
  const size = shrinkToFitPx(title, portrait ? 84 : 56, 14, portrait ? 40 : 30);
  const tag = tagline
    ? `<div style="font-size:13px;font-weight:800;letter-spacing:3px;color:var(--color-accent-strong);` +
      `text-transform:uppercase;white-space:nowrap;margin-top:6px">${esc(tagline)}</div>`
    : "";
  const logo =
    brand !== undefined
      ? brandLogoPlaceholder(
          brand.name ?? "",
          "height:44px;max-width:170px;object-fit:contain;flex:none",
        )
      : `<div style="flex:none;width:150px;height:44px;background:var(--color-surface);border:2px solid var(--color-text)"></div>`;
  return (
    `<header style="height:${h}px;flex:none;display:flex;flex-direction:column;justify-content:center;` +
    `padding:0 ${PAD_SIDE}px;overflow:hidden">` +
    `<div style="border-top:6px solid var(--color-text);border-bottom:2px solid var(--color-text);height:4px"></div>` +
    `<div style="display:flex;align-items:center;justify-content:space-between;gap:18px;min-width:0;` +
    `padding:${portrait ? 14 : 6}px 0">` +
    `<div style="min-width:0">` +
    `<div style="font-family:'Shrikhand',serif;font-size:${size}px;line-height:1.02;color:var(--color-text);` +
    `white-space:nowrap;transform:rotate(-1.5deg);transform-origin:left center">${esc(title)}</div>` +
    tag +
    `</div>` +
    `<div style="display:flex;align-items:center;gap:14px">${starburst(portrait ? 54 : 40)}${logo}</div>` +
    `</div>` +
    `<div style="border-top:2px solid var(--color-text);border-bottom:6px solid var(--color-text);height:4px"></div>` +
    `</header>`
  );
}

// ── the vocabulary ───────────────────────────────────────────────────────────────────────────────
export const boldPosterVocabulary: ComponentVocabulary = {
  id: "bold-poster",
  version: 1,
  registerNames: ["L", "M", "S"],
  defaultPhotoMode: "filmstrip",
  // 420 (vs dhaba's 430) lets a packed 50-item landscape board escalate to a 4th column
  // (1824-wide body → 423px columns) instead of overflowing at 3 — S-register rows still fit
  // the longest fixture names in 423px without wrapping.
  minStreamWidth: 420,
  sectionGap: 18,
  landscapeBannerHeight: 210,

  photoBandCapacity(bandWidth: number): number {
    // Cards never narrower than the S-register cover shot; bigger registers scale within the count.
    return Math.max(1, Math.floor(bandWidth / REGISTERS.S.cardW));
  },

  contentBox(canvas: VocabCanvas): { width: number; height: number } {
    return {
      width: canvas.width - 2 * PAD_SIDE,
      height: canvas.height - mastheadH(canvas) - PAD_TOP - PAD_BOTTOM,
    };
  },

  metrics(register) {
    const r = registerByName(register);
    return metricsFromNumbers({
      rowHeight: rowH(r, false),
      headerHeight: headerH(r, false),
      smallRowHeight: rowH(r, true),
      smallHeaderHeight: headerH(r, true),
      photoBandHeight: bandH(r),
      cueHeight: Math.max(14, r.headline * 0.5) * 1.2 + r.headerMb,
      singleColumnMax: 4,
    });
  },

  renderShell(args: ShellArgs): string {
    // Root owns the page: cream paper, crop marks, masthead, then the padded body column (the same
    // insets contentBox subtracts). No token declarations, no document chrome — the renderer's
    // wrapper declares tokens; the packager owns the document and fonts.
    return (
      `<div data-composed="bold-poster@1" style="width:${args.canvas.width}px;height:${args.canvas.height}px;` +
      `background:var(--color-bg);color:var(--color-text);font-family:'Archivo',sans-serif;` +
      `position:relative;display:flex;flex-direction:column;overflow:hidden">` +
      cropMark("top:16px;left:16px") +
      cropMark("top:16px;right:16px;transform:scaleX(-1)") +
      cropMark("bottom:16px;left:16px;transform:scaleY(-1)") +
      cropMark("bottom:16px;right:16px;transform:scale(-1,-1)") +
      masthead(args.title, args.tagline, args.brand, args.canvas) +
      `<div style="flex:1;display:flex;flex-direction:column;` +
      `padding:${PAD_TOP}px ${PAD_SIDE}px ${PAD_BOTTOM}px;min-height:0">` +
      args.bodyHtml +
      `</div>` +
      `</div>`
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
    return editorialBand(args.sections, args.startNumber, registerByName(args.register));
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
    section:
      "a numbered editorial section — a small red kicker (NO. 01) over a big display headline and thin ink rule, then dotted-leader price rows (1–3 columns, sized automatically)",
    group:
      "2–3 SMALL sections side by side separated by thin ink rules — use for categories of ~2–5 items",
    photoBand:
      "a scrolling filmstrip of framed cover-shot photo cards on tan panels with paper captions",
  },
};
