import type { ContrastConfig } from "../config/qa";
import type { Rgba } from "../ports/browser";

/**
 * WCAG 2.x contrast math — pure functions over RGBA. The browser samples the actual
 * rendered fg/bg pixels (D3/S8); this module never touches the DOM.
 */

interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Composite a (possibly translucent) foreground over an opaque background. */
export function compositeOver(fg: Rgba, bg: Rgba): Rgb {
  const a = Math.max(0, Math.min(1, fg.a));
  return {
    r: fg.r * a + bg.r * (1 - a),
    g: fg.g * a + bg.g * (1 - a),
    b: fg.b * a + bg.b * (1 - a),
  };
}

function linearize(channel8: number): number {
  const s = channel8 / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of an opaque colour. */
export function relativeLuminance(rgb: Rgb): number {
  return 0.2126 * linearize(rgb.r) + 0.7152 * linearize(rgb.g) + 0.0722 * linearize(rgb.b);
}

/**
 * WCAG contrast ratio (1–21) between a foreground (composited over the background if
 * translucent) and an opaque background.
 */
export function contrastRatio(fg: Rgba, bg: Rgba): number {
  const fgOpaque = compositeOver(fg, bg);
  const l1 = relativeLuminance(fgOpaque);
  const l2 = relativeLuminance({ r: bg.r, g: bg.g, b: bg.b });
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Whether text counts as "large" for WCAG (lower threshold applies). */
export function isLargeText(fontPx: number, bold: boolean, config: ContrastConfig): boolean {
  return fontPx >= config.largeTextPx || (bold && fontPx >= config.largeBoldPx);
}

/** The minimum acceptable contrast ratio for a given text size/weight. */
export function requiredRatio(fontPx: number, bold: boolean, config: ContrastConfig): number {
  return isLargeText(fontPx, bold, config) ? config.minLarge : config.minNormal;
}
