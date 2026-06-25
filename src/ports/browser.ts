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

export interface ImageObservation {
  ref: string;
  loaded: boolean;
  naturalWidth: number;
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
