import type { BrandInput } from "../domain/types";

/** A resolved menu section handed to a vocabulary: title + display-ready items. */
export interface VocabSection {
  title: string;
  items: VocabItem[];
}
export interface VocabItem {
  id: string;
  name: string;
  /** null = market price (vocabulary renders its MP treatment). */
  price: number | null;
  /** True when the item has a photo (renderer emits a data-img-item placeholder for it). */
  hasImage: boolean;
  /**
   * The planned per-section image-slot name this item's photo satisfies (the section title
   * `checkImageSlots` keys on). Vocabularies stamp `data-image-slot="<slot>"` on the photo
   * element/card so a per-section slot is verifiable inside a shared band. Undefined for a
   * board-level (shared) slot item — the band root's `data-image-slot="shared"` already
   * satisfies it. Additive, non-breaking.
   */
  slot?: string;
}

export interface VocabCanvas {
  width: number;
  height: number;
}

/** How a photoBand presents its photos. The theme picks its default; config may override. */
export type PhotoBandMode = "static" | "crossfade" | "filmstrip";

/**
 * Size/space metrics for ONE register — everything the generic layout engine needs to fit
 * content without knowing any theme CSS. All heights in px at the given register.
 */
export interface VocabularyMetrics {
  /** Estimated height of a full-width section at `internalCols` internal price columns. */
  sectionHeight(itemCount: number, internalCols: number): number;
  /** Estimated height of a side-by-side group band (driven by its tallest member). */
  groupHeight(itemCounts: number[]): number;
  /** Height of a photo band at this register (stack mode). */
  photoBandHeight(): number;
  /** Landscape flow: estimated height of one continuation row / one lead (header+first row). */
  flowRowHeight(): number;
  flowLeadHeight(): number;
  /** Height of the continuation cue line stamped at a spilled column top. */
  cueHeight(): number;
  /** Internal price columns a section of `itemCount` uses when up to `max` are allowed. */
  sectionInternalCols(itemCount: number, max: number): number;
}

/** Arguments for shell rendering (frame + masthead around the body). */
export interface ShellArgs {
  title: string;
  tagline: string | null;
  canvas: VocabCanvas;
  register: string;
  bodyHtml: string;
  brand?: BrandInput;
}

/**
 * A pluggable theme component package (D71): hand-designed components, mined per theme, that
 * render the engine's three abstract block kinds in the theme's visual language. Implementations
 * are PURE (no IO, no clock, no randomness) and must emit ENGINE-LEGAL markup:
 *   - one single root element per render call (the packager wraps the document);
 *   - theme tokens as var(--color-<token>) only — the shell declares them from the theme;
 *   - every item row stamped data-item-id="<id>" (binding-integrity QA);
 *   - every photo as `<img data-img-item="<id>" data-img-index="0">` with NO src
 *     (the packager inlines the offline data-URI — spec §5.1);
 *   - no external <link>/<script>; fonts come from theme assets via the packager.
 */
export interface ComponentVocabulary {
  id: string;
  /** Bumped when rendered output changes materially (pixel-test snapshots key on it). */
  version: number;
  /** Register names, LARGEST first (the layout engine searches in this order). */
  registerNames: readonly string[];
  /** Theme default presentation for photoBand blocks. */
  defaultPhotoMode: PhotoBandMode;
  /** The theme's content box inside its shell chrome (frame, masthead, padding). */
  contentBox(canvas: VocabCanvas): { width: number; height: number };
  /** Landscape flow tuning owned by the theme's type: narrowest legible column, rhythm, banner. */
  minStreamWidth: number;
  sectionGap: number;
  landscapeBannerHeight: number;
  /**
   * Max photo cards a band of `bandWidth` px can hold before its cards would fall below the theme's
   * narrowest legible size — a THEME-DERIVED capacity (card geometry is the vocabulary's), so the
   * renderer caps the collage to what the band's width actually accommodates instead of cramming cards
   * the fixed frame then crops. The renderer takes the min of this and the mode's carousel cap; the
   * slot-coverage guarantee is honoured WITHIN the result.
   */
  photoBandCapacity(bandWidth: number): number;
  metrics(register: string): VocabularyMetrics;
  renderShell(args: ShellArgs): string;
  renderSection(args: {
    number: number;
    section: VocabSection;
    internalCols: number;
    register: string;
  }): string;
  renderGroup(args: { startNumber: number; sections: VocabSection[]; register: string }): string;
  renderPhotoBand(args: {
    items: VocabItem[];
    register: string;
    bandHeight: number;
    bandWidth: number;
    mode: PhotoBandMode;
    uid: string;
  }): string;
  /** Landscape flow pieces: lead = numbered header GLUED to the first row (never orphaned). */
  renderFlowLead(args: { number: number; section: VocabSection; register: string }): string;
  renderFlowRow(args: { item: VocabItem; register: string }): string;
  renderContinuationCue(args: { sectionTitle: string; register: string }): string;
  /**
   * One line per block kind describing this theme's rendering, injected into the composer
   * prompt (e.g. `photoBand: "a filmstrip of tilted polaroid photo cards"`), so the LLM
   * composes with the theme's voice in mind without ever seeing HTML.
   */
  promptNotes: Readonly<Record<"section" | "group" | "photoBand", string>>;
}

/** Resolves a vocabulary id (the theme's `vocabulary` field) to its package. Pure + sync. */
export interface VocabularyRegistry {
  get(id: string): ComponentVocabulary | undefined;
}
