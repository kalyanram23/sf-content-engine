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
    images: [{ ref: "gallery-0", loaded: true, naturalWidth: 1200 }],
  };
}

/** A render with dead space at the bottom (acceptance test #1 seed, spec §7). */
export function deadSpaceObservation(): RenderObservation {
  return cleanObservation({ fillRatio: 0.22 });
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
