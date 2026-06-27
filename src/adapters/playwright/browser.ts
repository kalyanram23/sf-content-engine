import { chromium } from "playwright-core";

import { RenderError } from "../../domain/errors";
import type {
  BrowserPort,
  RenderObservation,
  RenderRequest,
  RenderResult,
} from "../../ports/browser";

// `document`/`window` resolve inside the browser context of page.evaluate, not in Node.
// Declared as `any` here so this adapter type-checks without pulling the DOM lib into the
// pure core (which must stay DOM-free).
declare const document: any;
declare const window: any;
declare const getComputedStyle: (el: unknown) => any;

export interface PlaywrightBrowserOptions {
  /** Extra Chromium launch args (e.g. `--no-sandbox` in containers). */
  launchArgs?: string[];
  /** Max grid samples per axis for the fill-ratio estimate. */
  fillGrid?: { cols: number; rows: number };
}

/**
 * Headless-Chromium {@link BrowserPort} (spec §5.6a). Renders at the EXACT viewport + DPR
 * with the network DISABLED (offline-safety, §5.1: any external fetch fails the asset), then
 * collects observations. Contrast uses computed-style colour pairs as a cheap pre-filter;
 * full pixel sampling over images/gradients is the documented upgrade (D3/S8), validated by
 * the gated live test. A fresh browser is launched per render to stay stateless.
 */
export class PlaywrightBrowser implements BrowserPort {
  constructor(private readonly options: PlaywrightBrowserOptions = {}) {}

  async render(request: RenderRequest): Promise<RenderResult> {
    const browser = await chromium.launch({ args: this.options.launchArgs ?? [] });
    try {
      const context = await browser.newContext({
        viewport: { width: request.viewport.width, height: request.viewport.height },
        deviceScaleFactor: request.viewport.dpr,
      });
      const page = await context.newPage();
      // Disable the network: only inline (data:) content may load.
      await page.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith("data:") || url.startsWith("about:")) return route.continue();
        return route.abort();
      });
      await page.setContent(request.html, { waitUntil: "load" });

      // Some transpilers (tsx/esbuild's `keepNames`) wrap named functions with a `__name()`
      // helper. `page.evaluate` serializes `collectObservation`'s source — which then references
      // `__name` — into the page, where it is undefined ("ReferenceError: __name is not defined").
      // Define a no-op shim first, as a raw string so it is not itself transpiled. Idempotent and
      // harmless under runtimes that don't inject `__name`.
      await page.evaluate("globalThis.__name = globalThis.__name || function (f) { return f; };");

      const grid = this.options.fillGrid ?? { cols: 48, rows: 27 };
      const observation = (await page.evaluate(collectObservation, grid)) as RenderObservation;
      const screenshot = await page.screenshot({ type: "png" });
      return { observation, screenshotBase64: screenshot.toString("base64") };
    } catch (error) {
      throw new RenderError("Playwright render failed.", { cause: error });
    } finally {
      await browser.close();
    }
  }
}

// Runs INSIDE the browser. Kept self-contained (no external refs) so it serializes cleanly.
function collectObservation(grid: { cols: number; rows: number }): unknown {
  const toRgba = (css: string) => {
    const m = css.match(/rgba?\(([^)]+)\)/);
    if (!m) return { r: 0, g: 0, b: 0, a: 1 };
    const parts = (m[1] ?? "").split(",").map((s) => parseFloat(s.trim()));
    return {
      r: parts[0] || 0,
      g: parts[1] || 0,
      b: parts[2] || 0,
      a: parts[3] === undefined ? 1 : parts[3],
    };
  };
  const cssSelector = (el: any): string => {
    const itemAncestor = el.closest("[data-item-id]");
    const bind = el.getAttribute("data-bind");
    if (itemAncestor && bind) {
      return `[data-item-id="${itemAncestor.getAttribute("data-item-id")}"] [data-bind="${bind}"]`;
    }
    if (itemAncestor) return `[data-item-id="${itemAncestor.getAttribute("data-item-id")}"]`;
    return el.tagName.toLowerCase();
  };
  const effectiveBackground = (el: any) => {
    let node: any = el;
    while (node) {
      const bg = toRgba(getComputedStyle(node).backgroundColor);
      if (bg.a > 0) return bg;
      node = node.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 };
  };

  const root = document.documentElement;
  const vw = window.innerWidth;
  const vh = window.innerHeight;

  const textSamples: any[] = [];
  const all = Array.from(document.querySelectorAll("body *")) as any[];
  for (const el of all) {
    const text = (el.textContent || "").trim();
    const hasOwnText = Array.from(el.childNodes).some(
      (n: any) => n.nodeType === 3 && (n.textContent || "").trim().length > 0,
    );
    if (!text || !hasOwnText) continue;
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") continue;
    textSamples.push({
      ref: cssSelector(el),
      itemId: el.closest("[data-item-id]")?.getAttribute("data-item-id") || undefined,
      fg: toRgba(style.color),
      bg: effectiveBackground(el),
      fontPx: parseFloat(style.fontSize) || 16,
      bold: parseInt(style.fontWeight, 10) >= 600,
      bbox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
    });
    if (textSamples.length >= 80) break;
  }

  const overflowing: any[] = [];
  for (const el of all) {
    const rect = el.getBoundingClientRect();
    if (rect.right > vw + 1 || rect.bottom > vh + 1) {
      overflowing.push({
        ref: cssSelector(el),
        bbox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      });
    }
    if (overflowing.length >= 40) break;
  }

  // Fill-ratio: fraction of a sampled grid landing on *content*. A sample counts only if it
  // hits text, an image/icon, or a surface visually distinct from the page background (a
  // card/panel). A full-bleed wrapper painted in the page background colour does NOT count —
  // otherwise any backgrounded screen reads as 100% filled and trips "over-crammed".
  const bodyBg = toRgba(getComputedStyle(document.body).backgroundColor);
  const sameColor = (a: any, b: any) =>
    Math.abs(a.r - b.r) < 8 && Math.abs(a.g - b.g) < 8 && Math.abs(a.b - b.b) < 8;
  const ownText = (el: any) =>
    Array.from(el.childNodes).some(
      (n: any) => n.nodeType === 3 && (n.textContent || "").trim().length > 0,
    );
  let filled = 0;
  let total = 0;
  for (let i = 1; i < grid.cols; i++) {
    for (let j = 1; j < grid.rows; j++) {
      const x = (vw * i) / grid.cols;
      const y = (vh * j) / grid.rows;
      total += 1;
      let node: any = document.elementFromPoint(x, y);
      let depth = 0;
      while (node && node !== document.body && node !== document.documentElement && depth < 5) {
        const tag = node.tagName;
        if (tag === "IMG" || tag === "SVG" || tag === "svg" || ownText(node)) {
          filled += 1;
          break;
        }
        const bg = toRgba(getComputedStyle(node).backgroundColor);
        if (bg.a > 0 && !sameColor(bg, bodyBg)) {
          filled += 1;
          break;
        }
        node = node.parentElement;
        depth += 1;
      }
    }
  }

  const images = (Array.from(document.querySelectorAll("img")) as any[]).map((img, i) => ({
    ref: img.getAttribute("data-ref") || `img-${i}`,
    loaded: img.complete && img.naturalWidth > 0,
    naturalWidth: img.naturalWidth,
  }));

  return {
    actualViewport: { width: vw, height: vh, dpr: window.devicePixelRatio },
    scroll: {
      scrollWidth: root.scrollWidth,
      scrollHeight: root.scrollHeight,
      clientWidth: root.clientWidth,
      clientHeight: root.clientHeight,
    },
    overflowing,
    textSamples,
    fillRatio: total === 0 ? 0 : filled / total,
    images,
  };
}
