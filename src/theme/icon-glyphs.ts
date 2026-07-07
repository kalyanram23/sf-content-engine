/**
 * Curated food-category icon glyphs (D-icon). LLM-drawn food art is unreliable — it ships
 * "unappetising dark blobs that look broken" even on an otherwise QA-passing board — so icon
 * quality is made DETERMINISTIC and engine-owned, mirroring the photo-placeholder scheme: the
 * painter emits a marker (`<svg data-icon="<name>">`) picking a name from this set, and the
 * packager injects the real glyph at package time (keeping painter HTML small and the icons clean).
 *
 * Each glyph is authored as a few minimal geometric paths in a square viewBox — line-art in the
 * lucide/feather register, NOT clip-art. Everything is `currentColor` (no fill/stroke colour of its
 * own) so a glyph inherits whatever theme text token the painter puts on the marker element, and it
 * uses viewBox units only — NO fixed px, NO raw hex — so a glyph stays token-clean wherever it lands.
 */

export interface IconGlyph {
  /** Square viewBox for the glyph. */
  viewBox: string;
  /** Inner SVG markup (paths/shapes) — currentColor-driven, no px, no hex. */
  inner: string;
}

/**
 * The curated glyph set: ~a dozen clean, recognisable food-category motifs. Author them carefully —
 * this is the ONE place the engine hand-writes SVG, and the whole point is that these read as
 * intentional design, so keep each a few balanced paths in the 0 0 24 24 grid.
 */
export const ICON_GLYPHS: Record<string, IconGlyph> = {
  "pizza-slice": {
    viewBox: "0 0 24 24",
    inner:
      '<path d="M3 7 L21 7 L12 21 Z"/>' +
      '<path d="M3 7 Q12 3 21 7"/>' +
      '<circle cx="10" cy="11" r="1"/>' +
      '<circle cx="14" cy="12" r="1"/>',
  },
  burger: {
    viewBox: "0 0 24 24",
    inner:
      '<path d="M3 11 a9 5 0 0 1 18 0"/>' +
      '<path d="M4 14 h16"/>' +
      '<path d="M5 17 h14 a2 2 0 0 1 -2 2 H7 a2 2 0 0 1 -2 -2 Z"/>',
  },
  "bowl-steam": {
    viewBox: "0 0 24 24",
    inner:
      '<path d="M3 12 h18 a9 9 0 0 1 -18 0 Z"/>' +
      '<path d="M2 12 h20"/>' +
      '<path d="M9 3 c-1 1.5 1 2 0 3.5"/>' +
      '<path d="M13 3 c-1 1.5 1 2 0 3.5"/>',
  },
  "curry-pot": {
    viewBox: "0 0 24 24",
    inner:
      '<path d="M5 10 h14 v5 a4 4 0 0 1 -4 4 H9 a4 4 0 0 1 -4 -4 Z"/>' +
      '<path d="M3 10 h18"/>' +
      '<path d="M10 7 h4"/>' +
      '<path d="M12 7 V5"/>' +
      '<path d="M5 13 H3"/>' +
      '<path d="M19 13 h2"/>',
  },
  noodles: {
    viewBox: "0 0 24 24",
    inner:
      '<path d="M4 12 h16 a8 8 0 0 1 -16 0 Z"/>' +
      '<path d="M6 9 c2 -2 4 2 6 0 s4 -2 6 0"/>' +
      '<path d="M14 3 l7 5"/>' +
      '<path d="M15 5 l6 4"/>',
  },
  taco: {
    viewBox: "0 0 24 24",
    inner:
      '<path d="M4 14 a8 6 0 0 1 16 0 Z"/>' +
      '<path d="M8 13 l1 -3"/>' +
      '<path d="M12 13 V9"/>' +
      '<path d="M16 13 l-1 -3"/>',
  },
  "dessert-sundae": {
    viewBox: "0 0 24 24",
    inner:
      '<path d="M6 9 h12 l-5 8 h-2 Z"/>' +
      '<path d="M12 17 v3"/>' +
      '<path d="M9 20 h6"/>' +
      '<path d="M7 9 a5 4 0 0 1 10 0"/>' +
      '<circle cx="12" cy="4" r="1"/>',
  },
  cupcake: {
    viewBox: "0 0 24 24",
    inner:
      '<path d="M6 12 h12 l-1 8 H7 Z"/>' +
      '<path d="M10 12 l1 8"/>' +
      '<path d="M14 12 l-1 8"/>' +
      '<path d="M6 12 a6 5 0 0 1 12 0 Z"/>' +
      '<circle cx="12" cy="5" r="1"/>',
  },
  "coffee-cup": {
    viewBox: "0 0 24 24",
    inner:
      '<path d="M4 8 h12 v6 a4 4 0 0 1 -4 4 H8 a4 4 0 0 1 -4 -4 Z"/>' +
      '<path d="M16 9 h2 a2 2 0 0 1 0 4 h-2"/>' +
      '<path d="M3 21 h14"/>' +
      '<path d="M8 3 c-1 1.2 1 2 0 3.2"/>' +
      '<path d="M12 3 c-1 1.2 1 2 0 3.2"/>',
  },
  "cold-drink": {
    viewBox: "0 0 24 24",
    inner:
      '<path d="M6 6 h12 l-1.5 14 h-9 Z"/>' +
      '<path d="M14 3 l-3 17"/>' +
      '<path d="M6.5 10 h11"/>',
  },
  bread: {
    viewBox: "0 0 24 24",
    inner:
      '<path d="M3 15 a9 7 0 0 1 18 0 a2 2 0 0 1 -2 2 H5 a2 2 0 0 1 -2 -2 Z"/>' +
      '<path d="M8 11 l-1 2"/>' +
      '<path d="M12 10 l-1 2"/>' +
      '<path d="M16 11 l-1 2"/>',
  },
  "leaf-salad": {
    viewBox: "0 0 24 24",
    inner:
      '<path d="M4 13 h16 a8 7 0 0 1 -16 0 Z"/>' +
      '<path d="M10 12 c-3 -1 -4 -4 -2 -7 3 1 4 4 2 7 Z"/>' +
      '<path d="M13 12 c1 -3 4 -4 6 -3 -1 3 -4 4 -6 3 Z"/>',
  },
  "platter-generic": {
    viewBox: "0 0 24 24",
    inner:
      '<path d="M3 16 a9 8 0 0 1 18 0 Z"/>' +
      '<path d="M2 16 h20"/>' +
      '<path d="M12 8 V6"/>' +
      '<circle cx="12" cy="5" r="1"/>',
  },
};

/** The fallback glyph used when a marker names a glyph the set does not carry. */
export const FALLBACK_ICON = "platter-generic";

/** The list of glyph names, offered to the painter so it PICKS one (never hand-draws food art). */
export const ICON_GLYPH_NAMES: readonly string[] = Object.keys(ICON_GLYPHS);

/** Resolve a marker's `data-icon` name to a glyph, falling back to the generic platter for an
 * unknown/absent name so a mistyped name still ships a clean icon rather than a broken marker. */
export function resolveGlyph(name: string | undefined | null): IconGlyph {
  return (
    (name !== undefined && name !== null ? ICON_GLYPHS[name] : undefined) ??
    ICON_GLYPHS[FALLBACK_ICON]!
  );
}

/** The full standalone `<svg>` for a glyph (currentColor line-art) — used by tests + any consumer
 * that wants a complete element rather than the inner markup the packager injects into a marker. */
export function glyphSvg(name: string): string {
  const glyph = resolveGlyph(name);
  return (
    `<svg viewBox="${glyph.viewBox}" fill="none" stroke="currentColor" stroke-width="1.5" ` +
    `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${glyph.inner}</svg>`
  );
}
