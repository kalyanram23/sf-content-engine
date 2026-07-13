/**
 * Shared vocabulary toolbox — photo-band CAROUSEL MECHANICS (timing, looping, layering) behind a
 * theme-supplied `renderCard` callback. The theme owns everything visible on a card (frame, border,
 * caption, tilt); this module owns the parts QA depends on:
 *
 *   - the band root carries `data-image-slot="shared"` and a FIXED height (`flex:none`) so the
 *     board-level shared slot is verifiable and the fitter's reserved band height matches;
 *   - both carousels ship a REDUCED-MOTION SETTLED FRAME: the QA browser renders with
 *     `reducedMotion:"reduce"`, and an unhandled cross-fade deck screenshots EMPTY (every layer's
 *     resting inline opacity is 0) while an unhandled filmstrip screenshots mid-scroll. The
 *     `@media (prefers-reduced-motion:reduce)` blocks pin a representative first frame with
 *     `!important` (required to beat the inline animation styles). TVs never set reduced motion,
 *     so live boards still animate — same bytes, honest QA frame;
 *   - animation names are scoped by the caller's `uid` so two bands on one board can't collide.
 *
 * Mirrors the validated mechanics in src/vocabularies/dhaba (the untouched reference, D78).
 */

import type { VocabItem } from "../../ports/vocabulary-registry";

/** Renders ONE photo card. Must include `cardSlotAttr(item)` on the card root and use
 * `imgPlaceholder` for the photo (src-less, packager-inlined). */
export type RenderCard = (item: VocabItem, index: number) => string;

export interface CrossfadeBandArgs {
  items: VocabItem[];
  bandHeight: number;
  /** Uniqueness scope for the generated keyframes (the renderer passes a per-block uid). */
  uid: string;
  renderCard: RenderCard;
  /** Seconds each photo is held on screen (default 3.5). */
  dwellSeconds?: number;
  /** Cross-dissolve seconds (default 0.7). */
  fadeSeconds?: number;
}

/**
 * CROSS-FADE DECK (pure CSS): N cards absolutely stacked; each visible for `dwell`s then fading to
 * the next, looping forever. Every layer runs the SAME keyframes over the full cycle, staggered by
 * `animation-delay` with `backwards` fill so a layer stays invisible until its slot.
 */
export function crossfadeBand(args: CrossfadeBandArgs): string {
  const { items, bandHeight, uid, renderCard } = args;
  const n = Math.max(1, items.length);
  const dwell = args.dwellSeconds ?? 3.5;
  const fade = args.fadeSeconds ?? 0.7;
  const cycle = +(n * dwell).toFixed(2);
  const slotPct = 100 / n;
  const fadePct = (fade / cycle) * 100;
  const anim = `xfade_${uid}`;
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
  const layers = items
    .map((item, i) => {
      const delay = (i * dwell).toFixed(2);
      const firstAttr = i === 0 ? " data-xf-first" : "";
      return (
        `<div data-anim="${anim}"${firstAttr} style="position:absolute;inset:0;display:flex;` +
        `justify-content:center;align-items:center;opacity:0;` +
        `animation:${anim} ${cycle}s linear ${delay}s infinite backwards">` +
        renderCard(item, i) +
        `</div>`
      );
    })
    .join("");
  return (
    `<div data-image-slot="shared" style="height:${bandHeight}px;flex:none;position:relative;overflow:hidden">` +
    `<style>${keyframes}${settled}</style>${layers}</div>`
  );
}

export interface FilmstripBandArgs {
  items: VocabItem[];
  bandHeight: number;
  uid: string;
  renderCard: RenderCard;
  /** Seconds of travel per card — calm and readable (default 4.5). */
  secondsPerCard?: number;
  /** Px between cards (default 30) — margin, so cards can never overlap. */
  gap?: number;
  /** Soft edge-fade so cards melt in/out at the band edges instead of hard-clipping (default on). */
  edgeFade?: boolean;
}

/**
 * SLIDING FILMSTRIP / marquee (pure CSS): a row of spaced cards scrolling left forever. The track
 * holds TWO identical copies and `translateX(0 → -50%)` moves it by exactly one copy's width for a
 * seamless wrap. Reduced motion reverts to `translateX(0)` — first cards visible.
 */
export function filmstripBand(args: FilmstripBandArgs): string {
  const { items, bandHeight, uid, renderCard } = args;
  const n = Math.max(1, items.length);
  const perCard = args.secondsPerCard ?? 4.5;
  const gap = args.gap ?? 30;
  const duration = +(n * perCard).toFixed(2);
  const anim = `slide_${uid}`;
  const card = (item: VocabItem, i: number): string =>
    `<div style="flex:none;margin:0 ${gap / 2}px">` + renderCard(item, i) + `</div>`;
  const copy = items.map(card).join("");
  const keyframes = `@keyframes ${anim}{from{transform:translateX(0)}to{transform:translateX(-50%)}}`;
  const settled = `@media (prefers-reduced-motion:reduce){[data-anim="${anim}"]{animation:none!important}}`;
  const edgeFade =
    (args.edgeFade ?? true)
      ? "mask-image:linear-gradient(to right,transparent,black 6%,black 94%,transparent);" +
        "-webkit-mask-image:linear-gradient(to right,transparent,black 6%,black 94%,transparent);"
      : "";
  return (
    `<div data-image-slot="shared" style="height:${bandHeight}px;flex:none;position:relative;overflow:hidden;${edgeFade}">` +
    `<style>${keyframes}${settled}</style>` +
    `<div data-anim="${anim}" style="position:absolute;top:0;left:0;height:100%;width:max-content;display:flex;` +
    `align-items:center;animation:${anim} ${duration}s linear infinite">${copy}${copy}</div>` +
    `</div>`
  );
}

/**
 * STATIC band root: fixed-height, slot-marked flex row for a non-animated photo arrangement (the
 * theme renders the cards/pile inside). `justify` defaults to center.
 */
export function staticBand(bandHeight: number, inner: string, justify = "center"): string {
  return (
    `<div data-image-slot="shared" style="height:${bandHeight}px;flex:none;display:flex;` +
    `justify-content:${justify};align-items:center">${inner}</div>`
  );
}
