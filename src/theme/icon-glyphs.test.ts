import { describe, expect, it } from "vitest";

import {
  FALLBACK_ICON,
  ICON_GLYPH_NAMES,
  ICON_GLYPHS,
  glyphSvg,
  resolveGlyph,
} from "./icon-glyphs";

// The same rails token-lint enforces on RAW painter markup. A glyph never reaches token-lint (the
// marker in raw HTML is an empty <svg data-icon>), but authoring glyphs token-clean is defence in
// depth AND keeps them theme-driven: currentColor only, viewBox units only, no raw hex, no raw px.
const HEX = /#[0-9a-fA-F]{3,8}\b/;
const PX = /\d*\.?\d+px\b/;

describe("icon glyph set integrity", () => {
  it("ships a curated dozen-ish food-category glyphs including the generic fallback", () => {
    expect(ICON_GLYPH_NAMES.length).toBeGreaterThanOrEqual(12);
    expect(ICON_GLYPH_NAMES).toContain(FALLBACK_ICON);
    expect(FALLBACK_ICON).toBe("platter-generic");
    // A spread across the food categories the painter picks from.
    for (const name of ["pizza-slice", "burger", "noodles", "coffee-cup", "leaf-salad"]) {
      expect(ICON_GLYPH_NAMES).toContain(name);
    }
  });

  it("every glyph is a viewBox'd, currentColor, token-clean svg with non-empty inner markup", () => {
    for (const name of ICON_GLYPH_NAMES) {
      const glyph = ICON_GLYPHS[name]!;
      expect(glyph.viewBox).toMatch(/^\d+ \d+ \d+ \d+$/);
      expect(glyph.inner.trim().length).toBeGreaterThan(0);
      const svg = glyphSvg(name);
      expect(svg).toContain(`viewBox="${glyph.viewBox}"`);
      expect(svg).toContain("currentColor");
      // Token-clean: no raw hex colour, no raw px length (the whole svg, inner included).
      expect(svg).not.toMatch(HEX);
      expect(svg).not.toMatch(PX);
      // currentColor is the ONLY colour source — no fixed fill/stroke colour of its own.
      expect(svg).not.toMatch(/(?:fill|stroke)="(?!none|currentColor)[a-z]/i);
    }
  });
});

describe("resolveGlyph", () => {
  it("resolves a known name to its glyph", () => {
    expect(resolveGlyph("pizza-slice")).toBe(ICON_GLYPHS["pizza-slice"]);
  });

  it("falls back to the generic platter for an unknown / absent name", () => {
    const platter = ICON_GLYPHS[FALLBACK_ICON];
    expect(resolveGlyph("no-such-icon")).toBe(platter);
    expect(resolveGlyph(undefined)).toBe(platter);
    expect(resolveGlyph(null)).toBe(platter);
  });
});
