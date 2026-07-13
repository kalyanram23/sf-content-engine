/**
 * Shared vocabulary toolbox — masthead SHRINK-TO-FIT sizing. The composer controls the board
 * title's text, so a theme's fixed-height masthead must scale the font down for long titles
 * instead of wrapping or clipping (dhaba reference: 46px at 15 chars, floored at 26px).
 */

/**
 * Font size (px) that keeps `title` on ONE line in a band tuned for `basePx` at `baseChars`
 * characters: longer titles step down proportionally, clamped to [floorPx, basePx].
 */
export function shrinkToFitPx(
  title: string,
  basePx: number,
  baseChars: number,
  floorPx: number,
): number {
  return Math.max(
    floorPx,
    Math.min(basePx, Math.floor((basePx * baseChars) / Math.max(baseChars, title.length))),
  );
}
