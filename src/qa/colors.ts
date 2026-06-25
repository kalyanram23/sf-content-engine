import type { Rgba } from "../ports/browser";

/** A handful of CSS named colours the painter/theme might use; extend as needed. */
const NAMED: Readonly<Record<string, Rgba>> = {
  white: { r: 255, g: 255, b: 255, a: 1 },
  black: { r: 0, g: 0, b: 0, a: 1 },
  transparent: { r: 0, g: 0, b: 0, a: 0 },
};

function clampByte(n: number): number {
  return Math.max(0, Math.min(255, Math.round(n)));
}

function expandHex(hex: string): string {
  // #rgb / #rgba → #rrggbb / #rrggbbaa
  if (hex.length === 3 || hex.length === 4) {
    return hex
      .split("")
      .map((c) => c + c)
      .join("");
  }
  return hex;
}

/**
 * Parse a CSS colour string (`#rgb[a]`, `#rrggbb[aa]`, `rgb()/rgba()`, a few named) into
 * {@link Rgba}. Returns `null` for anything unparseable (pure; no throw). Used by the
 * deterministic contrast repair to evaluate token candidates.
 */
export function parseColor(input: string): Rgba | null {
  const value = input.trim().toLowerCase();

  const named = NAMED[value];
  if (named) return named;

  if (value.startsWith("#")) {
    const hex = expandHex(value.slice(1));
    if (!/^[0-9a-f]{6}([0-9a-f]{2})?$/.test(hex)) return null;
    const r = parseInt(hex.slice(0, 2), 16);
    const g = parseInt(hex.slice(2, 4), 16);
    const b = parseInt(hex.slice(4, 6), 16);
    const a = hex.length === 8 ? parseInt(hex.slice(6, 8), 16) / 255 : 1;
    return { r, g, b, a };
  }

  const rgbMatch = /^rgba?\(\s*([^)]+)\)$/.exec(value);
  if (rgbMatch?.[1]) {
    const parts = rgbMatch[1].split(/[,/\s]+/).filter(Boolean);
    if (parts.length < 3) return null;
    const [rs, gs, bs, as] = parts;
    const r = clampByte(Number(rs));
    const g = clampByte(Number(gs));
    const b = clampByte(Number(bs));
    const a = as === undefined ? 1 : Math.max(0, Math.min(1, Number(as)));
    if ([r, g, b, a].some((n) => Number.isNaN(n))) return null;
    return { r, g, b, a };
  }

  return null;
}
