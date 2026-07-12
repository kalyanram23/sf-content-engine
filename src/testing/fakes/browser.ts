import type {
  BrowserPort,
  ItemRect,
  MeasureRequest,
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
  /** Per-grid-row fill counts (top→bottom); defaults to an all-filled grid (no dead band). */
  rowFill?: number[];
  /** Per-grid-row CONTENT fill counts (text/image samples); defaults to an all-content-filled grid.
   * checkDeadBand keys on this, so a fake whose surface is filled but whose content is empty in a
   * band sets a `rowContentFill` with a zero run while leaving `rowFill` full. */
  rowContentFill?: number[];
  /** Per-item layout rects; defaults to two rects sized to the canvas, both fully in-viewport (so
   * checkItemCutoff stays silent). A clipped-item fake supplies its own out-of-viewport rect. */
  itemRects?: ItemRect[];
}

/** The playwright fill grid samples `grid.rows - 1` interior rows (default grid.rows = 27). */
const FAKE_GRID_ROWS = 26;
/** An all-filled row grid — every sampled row lands on content, so checkDeadBand stays silent. */
function filledRowGrid(rows: number = FAKE_GRID_ROWS): number[] {
  return Array<number>(rows).fill(40);
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
    // Two item rects sized as fractions of the canvas so they sit fully in-viewport in BOTH
    // landscape (1920×1080) and portrait (1080×1920) — bottom ≤ 90% height, right ≤ 50% width — so a
    // clean fake never trips checkItemCutoff regardless of the orientation override. A clipped-item
    // fake (clippedItemObservation) appends a rect whose bottom exceeds the viewport.
    itemRects: overrides.itemRects ?? [
      {
        id: "p-margherita",
        top: 80,
        bottom: Math.round(height * 0.5),
        left: 40,
        right: Math.round(width * 0.5),
      },
      {
        id: "s-garlic-bread",
        top: Math.round(height * 0.5),
        bottom: Math.round(height * 0.9),
        left: 40,
        right: Math.round(width * 0.5),
      },
    ],
    rowFill: overrides.rowFill ?? filledRowGrid(),
    // Content-filled everywhere unless a story says otherwise — so a clean fake never trips
    // checkDeadBand (which keys on rowContentFill). A dead-space fake supplies its own zero run.
    rowContentFill: overrides.rowContentFill ?? filledRowGrid(),
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
        // The front carousel slide / a lone photo is visible; a hidden-slide fixture scripts its own
        // `visible: false` image so the crop check ignores it (Fix 2).
        visible: true,
      },
    ],
  };
}

/**
 * A render with dead space at the bottom (acceptance test #1 seed, spec §7). The top ~half carries
 * content and the bottom ~46% is a contiguous run of ZERO-fill grid rows — the localised empty band
 * checkDeadBand flags — coherent with the low global fillRatio the density under-fill floor also sees.
 */
export function deadSpaceObservation(): RenderObservation {
  const rowFill = [...Array<number>(14).fill(18), ...Array<number>(12).fill(0)];
  // The empty band is genuinely empty of CONTENT too, so rowContentFill mirrors rowFill's zero run
  // (checkDeadBand keys on rowContentFill).
  return cleanObservation({ fillRatio: 0.22, rowFill, rowContentFill: rowFill });
}

/**
 * A render whose content extends past the bottom edge (content ~8% taller than the viewport) —
 * the "table cut off at the bottom" case a live vision judge rejected (D31). No item-bound text
 * samples, so no legibility floor binds: a uniform ~0.93 shrink stays legible AND above the config
 * `minShrinkFactor` floor (0.9 — small trims only), so the deterministic shrink-to-fit repair fixes
 * it WITHOUT a re-paint. Tune the overshoot via `scrollHeight`.
 */
export function overflowObservation(overrides: ObservationOverrides = {}): RenderObservation {
  const obs = cleanObservation(overrides);
  const { width, height } = obs.actualViewport;
  const scrollHeight = overrides.scrollHeight ?? Math.round(height * 1.08);
  return {
    ...obs,
    scroll: { scrollWidth: width, scrollHeight, clientWidth: width, clientHeight: height },
    overflowing: [
      { ref: "section.beverages", bbox: { x: 0, y: height, width, height: scrollHeight - height } },
    ],
  };
}

/**
 * The QA-blindspot fixture: a board that is CLEAN by every existing check — the page does NOT scroll
 * (scrollHeight == clientHeight, so checkOverflow stays silent) — yet a section's last item is
 * visually cut off at the bottom edge inside an `overflow:hidden` container. Only its LAYOUT rect
 * (`itemRects`) reveals it: item "e-last" has bottom past the viewport, so checkItemCutoff fires a
 * major, NOT-deterministically-fixable finding that routes to re-paint. `overhangPx` tunes how far
 * past the edge the item sits.
 */
export function clippedItemObservation(
  overrides: ObservationOverrides & { overhangPx?: number } = {},
): RenderObservation {
  const { overhangPx = 90, ...obsOverrides } = overrides;
  const obs = cleanObservation(obsOverrides);
  const { width, height } = obs.actualViewport;
  return {
    ...obs,
    itemRects: [
      ...(obs.itemRects ?? []),
      {
        id: "e-last",
        top: height - 60,
        bottom: height + overhangPx,
        left: 40,
        right: Math.round(width * 0.5),
      },
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

  /**
   * Deterministic MEASURE fake. The renderer can't know a fake's internals, so this returns a
   * configurable CONSTANT height per `data-mk` key parsed from the document: `24` for the sample
   * continuation cue (`__cue__`), `28` for every flow unit. Constant heights still exercise
   * partitioning, continuation cues, and the balance logic deterministically.
   */
  measure(request: MeasureRequest): Promise<Record<string, number>> {
    const keys = [...request.html.matchAll(/data-mk="([^"]+)"/g)].map((m) => m[1]!);
    return Promise.resolve(Object.fromEntries(keys.map((k) => [k, k === "__cue__" ? 24 : 28])));
  }
}
