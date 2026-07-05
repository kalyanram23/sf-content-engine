import type {
  BrowserPort,
  RenderObservation,
  RenderRequest,
  RenderResult,
  Rgba,
} from "../../ports/browser";

/** A tiny valid 1×1 PNG, base64 — a stand-in screenshot for fakes. */
export const PLACEHOLDER_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

const BLACK: Rgba = { r: 0, g: 0, b: 0, a: 1 };
const WHITE: Rgba = { r: 255, g: 255, b: 255, a: 1 };
const YELLOW: Rgba = { r: 255, g: 255, b: 0, a: 1 };

export interface ObservationOverrides {
  width?: number;
  height?: number;
  dpr?: number;
  fillRatio?: number;
  scrollHeight?: number;
  scrollWidth?: number;
}

/** A passing render: legible text, balanced fill, no overflow, images loaded. */
export function cleanObservation(overrides: ObservationOverrides = {}): RenderObservation {
  const width = overrides.width ?? 1920;
  const height = overrides.height ?? 1080;
  return {
    actualViewport: { width, height, dpr: overrides.dpr ?? 1 },
    scroll: {
      scrollWidth: overrides.scrollWidth ?? width,
      scrollHeight: overrides.scrollHeight ?? height,
      clientWidth: width,
      clientHeight: height,
    },
    overflowing: [],
    textSamples: [
      {
        ref: "h2.section-title",
        fg: WHITE,
        bg: BLACK,
        fontPx: 48,
        bold: true,
        bbox: { x: 0, y: 0, width: 400, height: 60 },
      },
      {
        ref: '[data-bind="price"]',
        fg: BLACK,
        bg: WHITE,
        fontPx: 32,
        bold: false,
        bbox: { x: 0, y: 100, width: 120, height: 40 },
      },
    ],
    fillRatio: overrides.fillRatio ?? 0.6,
    // Geometry defaults describe a well-proportioned, undistorted cover photo (§ Phase 4): a 3:2
    // natural photo in a 3:2 box → no distortion, no over-crop.
    images: [
      {
        ref: "gallery-0",
        loaded: true,
        naturalWidth: 1200,
        naturalHeight: 800,
        renderedWidth: 600,
        renderedHeight: 400,
        objectFit: "cover",
      },
    ],
  };
}

/** A render with dead space at the bottom (acceptance test #1 seed, spec §7). */
export function deadSpaceObservation(): RenderObservation {
  return cleanObservation({ fillRatio: 0.22 });
}

/**
 * A render whose content extends past the bottom edge (content ~15% taller than the viewport) —
 * the "table cut off at the bottom" case a live vision judge rejected (D31). No item-bound text
 * samples, so no legibility floor binds: a uniform ~0.87 shrink stays legible and the deterministic
 * shrink-to-fit repair fixes it WITHOUT a re-paint. Tune the overshoot via `scrollHeight`.
 */
export function overflowObservation(overrides: ObservationOverrides = {}): RenderObservation {
  const obs = cleanObservation(overrides);
  const { width, height } = obs.actualViewport;
  const scrollHeight = overrides.scrollHeight ?? Math.round(height * 1.15);
  return {
    ...obs,
    scroll: { scrollWidth: width, scrollHeight, clientWidth: width, clientHeight: height },
    overflowing: [
      { ref: "section.beverages", bbox: { x: 0, y: height, width, height: scrollHeight - height } },
    ],
  };
}

/**
 * An overflow that CANNOT be shrunk without dropping item text below the legibility floor: the
 * content is 2× too tall AND carries item-bound price text at 20px, so the fit factor (~0.5) would
 * render it at ~10px (< the 14px floor). {@link checkOverflow} marks it NOT deterministically
 * fixable, so it escalates to the LLM re-paint path instead of a futile, illegible shrink (D31).
 */
export function overflowClampObservation(): RenderObservation {
  const obs = cleanObservation();
  const { width, height } = obs.actualViewport;
  return {
    ...obs,
    scroll: {
      scrollWidth: width,
      scrollHeight: height * 2,
      clientWidth: width,
      clientHeight: height,
    },
    overflowing: [{ ref: "section.entrees", bbox: { x: 0, y: height, width, height } }],
    textSamples: [
      ...obs.textSamples,
      {
        ref: '[data-item-id="e-steak"] [data-bind="price"]',
        itemId: "e-steak",
        fg: BLACK,
        bg: WHITE,
        fontPx: 20,
        bold: false,
        bbox: { x: 0, y: 200, width: 100, height: 24 },
      },
    ],
  };
}

/**
 * A render with failing WCAG contrast — white price text on a yellow background (acceptance
 * test #2 seed, spec §7). The failing sample's `ref` is a selector the deterministic repair
 * scopes its override to.
 */
export function contrastFailObservation(): RenderObservation {
  const obs = cleanObservation();
  return {
    ...obs,
    textSamples: [
      obs.textSamples[0]!,
      {
        ref: '[data-item-id="p-margherita"] [data-bind="price"]',
        itemId: "p-margherita",
        fg: WHITE,
        bg: YELLOW,
        fontPx: 32,
        bold: false,
        bbox: { x: 0, y: 100, width: 120, height: 40 },
      },
    ],
  };
}

/**
 * A browser that returns scripted observations in order (clamped to the last), so the
 * generator–critic loop's convergence can be simulated deterministically.
 */
export class ScriptedBrowser implements BrowserPort {
  private index = 0;
  readonly renderCount = { value: 0 };

  constructor(
    private readonly observations: readonly RenderObservation[] = [cleanObservation()],
    private readonly screenshotBase64: string = PLACEHOLDER_PNG_BASE64,
  ) {}

  render(_request: RenderRequest): Promise<RenderResult> {
    const observation = this.observations[Math.min(this.index, this.observations.length - 1)]!;
    this.index += 1;
    this.renderCount.value += 1;
    return Promise.resolve({ observation, screenshotBase64: this.screenshotBase64 });
  }
}
