/**
 * The headless-browser port (spec §5.6a). It renders the packaged artifact at the EXACT
 * target viewport + DPR with the network disabled (offline-safety, §5.1) and returns a
 * screenshot plus structured {@link RenderObservation}s. The QA checks over those
 * observations are pure (D3); the browser does the sampling.
 */

export interface Rgba {
  /** 0–255. */
  r: number;
  g: number;
  b: number;
  /** Alpha 0–1. */
  a: number;
}

export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * A rendered text region with PIXEL-SAMPLED foreground/background colours (not computed
 * styles), so the pure WCAG math catches text-over-image/gradient cases (D3/S8).
 */
export interface TextSample {
  ref: string;
  itemId?: string;
  fg: Rgba;
  bg: Rgba;
  fontPx: number;
  bold: boolean;
  bbox: BoundingBox;
}

/**
 * The layout rectangle of a menu item (an element carrying `data-item-id`), in viewport pixels.
 * Reported from `getBoundingClientRect`, so it is the element's LAYOUT box even when an ancestor's
 * `overflow:hidden`/`clip` visually cuts it off — which is exactly why it catches SILENT clipping
 * (content sliced at the screen edge inside a clipped container, where nothing scrolls, so the
 * page-scroll {@link RenderObservation.scroll} overflow check stays blind). When an item id appears
 * on more than one element, the browser records the UNION box (min top/left, max bottom/right) so
 * there is exactly one rect per id.
 */
export interface ItemRect {
  id: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface ImageObservation {
  ref: string;
  loaded: boolean;
  naturalWidth: number;
  /**
   * Geometry for the image-distortion / image-crop checks (§ Phase 4). Optional so older
   * observations (and fakes that don't set them) stay valid; the geometry checks skip an image
   * whose fields are absent. `objectFit` is the computed `object-fit` style.
   */
  naturalHeight?: number;
  renderedWidth?: number;
  renderedHeight?: number;
  objectFit?: string;
  /**
   * Effective visibility of the image: `false` when it is provably hidden (computed `opacity:0` on
   * itself or an ancestor, or `display:none` / `visibility:hidden`) — e.g. every non-front slide of
   * a gallery-fade carousel. The image-crop check skips a non-visible image so a stack of hidden
   * carousel slides doesn't flood the report. Optional so older observations / fakes stay valid; an
   * ABSENT field is graded as before (treated as visible).
   */
  visible?: boolean;
}

export interface RenderObservation {
  /** Actual rendered viewport — a hard precondition checked against QaConfig (§5.6a). */
  actualViewport: { width: number; height: number; dpr: number };
  scroll: { scrollWidth: number; scrollHeight: number; clientWidth: number; clientHeight: number };
  /** Elements whose box extends past the viewport edge (overflow candidates). */
  overflowing: { ref: string; bbox: BoundingBox }[];
  textSamples: TextSample[];
  /** Fraction of the viewport covered by non-background content, [0,1] (density, §5.6). */
  fillRatio: number;
  /**
   * Per-grid-row fill COUNTS (one entry per sampled grid row, top→bottom): how many of that row's
   * grid samples landed on content. Feeds the dead-band check (a LOCALISED empty band the global
   * `fillRatio` misses on a board whose other half is rich). Optional so older observations / fakes
   * that don't set it stay valid — the check simply skips when it is absent.
   */
  rowFill?: number[];
  /**
   * Per-grid-row CONTENT fill counts (one entry per sampled grid row, top→bottom): how many of that
   * row's samples landed on real CONTENT — text or an image/icon — as opposed to a merely painted
   * surface. The dead-band check keys on THIS (falling back to {@link rowFill} for older
   * observations) so a full-height tinted panel with content only in its top half is still read as
   * dead space in its lower half. Optional so older observations / fakes that don't set it stay valid.
   */
  rowContentFill?: number[];
  /**
   * The LAYOUT rectangle of every menu item (element with `data-item-id`), one union rect per id —
   * see {@link ItemRect}. Feeds the item-cutoff check, which flags an item whose box extends past the
   * viewport edge even when nothing scrolls (silent clipping inside an `overflow:hidden` container).
   * Optional so older observations / fakes that don't set it stay valid — the check simply skips when
   * it is absent (backward compatible).
   */
  itemRects?: ItemRect[];
  images: ImageObservation[];
}

export interface RenderRequest {
  html: string;
  viewport: { width: number; height: number; dpr: number };
}

export interface RenderResult {
  observation: RenderObservation;
  /** Base64-encoded PNG screenshot of the rendered artifact. */
  screenshotBase64: string;
}

export interface BrowserPort {
  render(request: RenderRequest): Promise<RenderResult>;
}
