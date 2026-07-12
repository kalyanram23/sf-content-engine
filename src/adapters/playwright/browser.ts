import { chromium } from "playwright-core";

import { RenderError } from "../../domain/errors";
import type {
  BrowserPort,
  MeasureRequest,
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
        // Capture the settled, fully-revealed frame. The packaged motion runtime honours
        // prefers-reduced-motion by skipping its entrance reveal + carousel loop, so QA (and the
        // poster it ships) see the final state instead of the t=0 opacity:0 frame. The TV never
        // sets this, so the live HTML still animates — same bytes, different rendering preference.
        reducedMotion: "reduce",
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

      // Settle BEFORE observing/screenshotting: fonts/images finish asynchronously, and any
      // painter-authored entrance animation must be jumped to its end — so the observation AND the
      // screenshot (which feed the vision critic and the poster) both reflect the final frame, not a
      // mid-paint one (FOUT / undecoded data: images / a t≈0 opacity:0 entrance frame).
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      await page.evaluate(() =>
        Promise.all(
          (Array.from(document.images) as any[]).map((img) => img.decode().catch(() => undefined)),
        ).then(() => undefined),
      );
      // Jump every animation to its end state. Playwright's `reducedMotion: "reduce"` only flips the
      // media query — it does NOT stop a painter-authored RAW CSS entrance animation (e.g.
      // [data-motion="fade-in"] { animation: fadeIn 0.6s } with from{opacity:0}) sitting on the board
      // wrapper. The screenshot fires ~60ms after load, so such a board would be captured at ~10%
      // opacity — a washed ghost frame the vision critic and the offline judge grade as broken, while
      // the deterministic contrast check (computed styles) sees the correct final colours and passes.
      // The TV plays the entrance once then shows the settled frame forever, so that settled
      // steady-state frame is the honest QA target. Infinite-duration animations can't finish() (the
      // reduced-motion guard already stops the engine's own runtime loops), so leave them.
      await page.evaluate(() => {
        (document.getAnimations() as any[]).forEach((a) => {
          try {
            a.finish();
          } catch {
            /* infinite-duration animations cannot finish(); leave them. */
          }
        });
      });

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

  /**
   * MEASURE (D72): render the renderer's off-screen measure document at the given column width and
   * report every `[data-mk]` element's true `getBoundingClientRect().height`, keyed by its data-mk.
   * Same launch/offline plumbing as {@link render}. The measure document declares font-family
   * FALLBACKS only (no packaged @font-face is loaded here), so heights are computed against system
   * faces — the same font-size/line-height as the board, with a ±2px face-metric error the balance
   * slack absorbs (the accepted offline trade — D72).
   */
  async measure(request: MeasureRequest): Promise<Record<string, number>> {
    const browser = await chromium.launch({ args: this.options.launchArgs ?? [] });
    try {
      const context = await browser.newContext({
        viewport: { width: request.width, height: 1080 },
      });
      const page = await context.newPage();
      // Offline-safety (§5.1): only inline (data:) content may load.
      await page.route("**/*", (route) => {
        const url = route.request().url();
        if (url.startsWith("data:") || url.startsWith("about:")) return route.continue();
        return route.abort();
      });
      await page.setContent(request.html, { waitUntil: "load" });
      // Settle fonts (fall back to system faces offline) before measuring — same font-size/line-height
      // as the board so heights transfer 1:1 modulo the accepted ±2px face-metric slack.
      await page.evaluate(() => document.fonts.ready.then(() => undefined));
      const heights = (await page.evaluate(() =>
        Object.fromEntries(
          (Array.from(document.querySelectorAll("[data-mk]")) as any[]).map((el) => [
            el.getAttribute("data-mk"),
            el.getBoundingClientRect().height,
          ]),
        ),
      )) as Record<string, number>;
      return heights;
    } catch (error) {
      throw new RenderError("Playwright measure failed.", { cause: error });
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
    if (itemAncestor) {
      // Element-PRECISE ref for card text without a data-bind. A bare `[data-item-id]` container
      // ref is destructive downstream: a card mixes backgrounds (a light pill over the dark card
      // body), so a single-token contrast recolour scoped to the whole card fixes one face and
      // breaks the sibling. Point at THIS element instead: the single `<h3>` name → `[card] h3`
      // (unambiguous, short); one of several same-tag faces → a child-indexed nth-of-type path so
      // the override lands on this element alone. Refs stay stable across renders (structural, not
      // content-derived) and short (cards are shallow).
      const cardSel = `[data-item-id="${itemAncestor.getAttribute("data-item-id")}"]`;
      const tag = el.tagName.toLowerCase();
      if (itemAncestor.querySelectorAll(tag).length === 1) return `${cardSel} ${tag}`;
      const segments: string[] = [];
      let node: any = el;
      while (node && node !== itemAncestor && node.parentElement) {
        const t = node.tagName.toLowerCase();
        const sameType = (Array.from(node.parentElement.children) as any[]).filter(
          (c) => c.tagName === node.tagName,
        );
        segments.unshift(
          sameType.length === 1 ? t : `${t}:nth-of-type(${sameType.indexOf(node) + 1})`,
        );
        node = node.parentElement;
      }
      return `${cardSel} ${segments.join(" > ")}`;
    }
    // Element OUTSIDE any item card. A bare tag name (`span`) is UN-repairable downstream — a
    // `span{…}` contrast override would recolour every span on the board — so the loop wasted
    // re-paints while the invisible text survived. Emit a SHORT, UNIQUE path instead: anchor on the
    // nearest ancestor carrying an id / data-ref / section-ish landmark, then a tag[:nth-of-type]
    // chain down to THIS element (capped so it stays short). Structural → stable across renders, and
    // scopable → a repair can target just this element's subtree.
    const LANDMARK = /^(section|main|header|nav|article|aside|footer|ul|ol)$/;
    const stepSel = (node: any): string => {
      const t = node.tagName.toLowerCase();
      const parent = node.parentElement;
      if (!parent) return t;
      const same = (Array.from(parent.children) as any[]).filter((c) => c.tagName === node.tagName);
      return same.length === 1 ? t : `${t}:nth-of-type(${same.indexOf(node) + 1})`;
    };
    const segments: string[] = [];
    let node: any = el;
    let anchor: string | undefined;
    while (node && node !== document.body && node !== document.documentElement) {
      const id = node.getAttribute("id");
      const ref = node.getAttribute("data-ref");
      if (id) {
        anchor = `#${id}`;
        break;
      }
      if (ref) {
        anchor = `[data-ref="${ref}"]`;
        break;
      }
      segments.unshift(stepSel(node));
      // Stop at (and root on) the nearest enclosing landmark — its own step is already unshifted.
      if (LANDMARK.test(node.tagName.toLowerCase())) {
        anchor = "";
        break;
      }
      // Keep the ref short: ~4 segments is plenty for shallow signage DOM.
      if (segments.length >= 4) {
        anchor = "";
        break;
      }
      node = node.parentElement;
    }
    if (anchor === undefined) anchor = node === document.body ? "body" : "";
    const parts = [anchor, ...segments].filter((s) => s !== "");
    return parts.length > 0 ? parts.join(" > ") : el.tagName.toLowerCase();
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

  // Per-item LAYOUT rects (union box per data-item-id). getBoundingClientRect reports the layout
  // box even when an ancestor's overflow:hidden/clip visually cuts the element off — so an item
  // sliced at the screen edge inside a clipped container (where nothing scrolls) is still measurable
  // here. The item-cutoff check flags any rect extending past the viewport. Union multiple elements
  // sharing one id (e.g. a matrix item split across cells) into a single min/max box.
  const itemRectById = new Map<string, any>();
  for (const el of Array.from(document.querySelectorAll("[data-item-id]")) as any[]) {
    const id = el.getAttribute("data-item-id");
    if (!id) continue;
    const rect = el.getBoundingClientRect();
    // Skip zero-area elements (display:none / not laid out) — they carry no meaningful geometry.
    if (rect.width === 0 && rect.height === 0) continue;
    const prev = itemRectById.get(id);
    if (prev === undefined) {
      itemRectById.set(id, {
        id,
        top: rect.top,
        bottom: rect.bottom,
        left: rect.left,
        right: rect.right,
      });
    } else {
      prev.top = Math.min(prev.top, rect.top);
      prev.left = Math.min(prev.left, rect.left);
      prev.bottom = Math.max(prev.bottom, rect.bottom);
      prev.right = Math.max(prev.right, rect.right);
    }
  }
  const itemRects = Array.from(itemRectById.values());

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
  // Per-grid-row fill counts (top→bottom), one entry per sampled row j (1..grid.rows-1) — the
  // dead-band check finds the longest run of ZERO-fill rows the global fillRatio can't see.
  const rowFill: number[] = [];
  // Per-row CONTENT fill: samples that hit real content (TEXT or IMG/SVG) — the FIRST arm below —
  // NOT a mere painted surface (the second arm). The dead-band check keys on this so a full-height
  // tinted panel with content only in its top half is correctly read as dead space in its lower
  // half (a painted-but-contentless row is "filled" for over-cram detection but empty of content).
  const rowContentFill: number[] = [];
  for (let j = 1; j < grid.rows; j++) {
    const y = (vh * j) / grid.rows;
    let rowFilled = 0;
    let rowContentFilled = 0;
    for (let i = 1; i < grid.cols; i++) {
      const x = (vw * i) / grid.cols;
      total += 1;
      let node: any = document.elementFromPoint(x, y);
      let depth = 0;
      while (node && node !== document.body && node !== document.documentElement && depth < 5) {
        const tag = node.tagName;
        if (tag === "IMG" || tag === "SVG" || tag === "svg" || ownText(node)) {
          rowFilled += 1;
          rowContentFilled += 1;
          break;
        }
        const bg = toRgba(getComputedStyle(node).backgroundColor);
        if (bg.a > 0 && !sameColor(bg, bodyBg)) {
          rowFilled += 1;
          break;
        }
        node = node.parentElement;
        depth += 1;
      }
    }
    filled += rowFilled;
    rowFill.push(rowFilled);
    rowContentFill.push(rowContentFilled);
  }

  // Effective visibility — the same cheap ancestor walk `effectiveBackground` uses: an image is
  // hidden when it (or any ancestor) computes to opacity 0, display:none, or visibility:hidden. Lets
  // the image-crop check ignore the opacity-0 slides a gallery-fade carousel stacks (all but one).
  const isVisible = (el: any): boolean => {
    let node: any = el;
    while (node && node !== document.documentElement) {
      const s = getComputedStyle(node);
      if (s.display === "none" || s.visibility === "hidden" || parseFloat(s.opacity) === 0) {
        return false;
      }
      node = node.parentElement;
    }
    return true;
  };

  const images = (Array.from(document.querySelectorAll("img")) as any[]).map((img, i) => {
    const rect = img.getBoundingClientRect();
    return {
      ref: img.getAttribute("data-ref") || `img-${i}`,
      loaded: img.complete && img.naturalWidth > 0,
      naturalWidth: img.naturalWidth,
      naturalHeight: img.naturalHeight,
      renderedWidth: rect.width,
      renderedHeight: rect.height,
      objectFit: getComputedStyle(img).objectFit,
      visible: isVisible(img),
    };
  });

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
    rowFill,
    rowContentFill,
    itemRects,
    images,
  };
}
