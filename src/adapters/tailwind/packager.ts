import { createRequire } from "node:module";
import { dirname } from "node:path";

import { compile } from "@tailwindcss/node";
import { type HTMLElement, parse } from "node-html-parser";

import { PackagingError } from "../../domain/errors";
import type { CanonicalItem, ResolvedTheme } from "../../domain/types";
import type { Packager, PackageRequest } from "../../ports/packager";
import { PLACEHOLDER_IMAGE_DATA_URI } from "../../util/placeholder-image";
import { MOTION_LIB } from "./motion-bundle.generated";

/**
 * Tailwind v4 packager (spec §5.2, D4): extracts candidate utility classes from the painted
 * markup, compiles them to static CSS via `@tailwindcss/node` (theme tokens injected as
 * `@theme` so `text-<token>` etc. resolve), inlines the preset background + a Motion-runtime
 * marker, and wraps everything in a self-contained, offline-safe document. Resolution is
 * hermetic (relative to THIS package, not `process.cwd()` — S7). A minimal motion runtime is
 * inlined as a v1 stand-in for the full motion.dev preset interpreter (D14 seam).
 */
export class TailwindPackager implements Packager {
  async package(request: PackageRequest): Promise<string> {
    try {
      const root = parse(request.html);
      // Fill every carousel/photo placeholder with a data-URI BEFORE serializing, so the
      // shipped artifact never carries a remote src (offline-safe, §5.1).
      inlineItemImages(root, request.items);
      inlineBrandLogo(root, request.brandLogoDataUri);
      const useRuntimeMotion = usesRuntimeMotion(root, request.theme);
      const body = root.toString();

      const candidates = extractCandidates(root);
      const input = `@import "tailwindcss";\n${themeBlock(request.theme)}`;
      const compiler = await compile(input, { base: resolveBase(), onDependency: () => {} });
      const utilities = compiler.build(candidates);
      const css = `${utilities}\n${baseStyles(request.theme)}`;
      return document(css, body, motionRuntime(useRuntimeMotion));
    } catch (error) {
      if (error instanceof PackagingError) throw error;
      throw new PackagingError("Tailwind packaging failed.", { cause: error });
    }
  }
}

function extractCandidates(root: HTMLElement): string[] {
  const set = new Set<string>();
  for (const el of root.querySelectorAll("[class]")) {
    for (const cls of (el.getAttribute("class") ?? "").split(/\s+/)) if (cls) set.add(cls);
  }
  return [...set];
}

/**
 * Resolve the painter's photo placeholders to inlined data-URIs (the shared painter↔packager
 * scheme): the painter emits `<img data-img-item data-img-index>` with NO src; we look up the
 * item's resolved (data-URI) image and write it as the real src, or an offline placeholder
 * when missing — so `checkSelfContained` only ever sees data-URIs.
 */
function inlineItemImages(root: HTMLElement, items: readonly CanonicalItem[]): void {
  const byId = new Map(items.map((i) => [i.id, i]));
  for (const el of root.querySelectorAll("[data-img-item]")) {
    const id = el.getAttribute("data-img-item") ?? "";
    const rawIdx = Number(el.getAttribute("data-img-index") ?? "0");
    const idx = Number.isInteger(rawIdx) && rawIdx >= 0 ? rawIdx : 0;
    const uri = byId.get(id)?.images?.[idx];
    el.setAttribute("src", uri && uri.trim() !== "" ? uri : PLACEHOLDER_IMAGE_DATA_URI);
  }
}

/** Fill the painter's `<img data-brand-logo>` header placeholder (no src) with the resolved brand
 * logo data-URI, or the offline placeholder when no logo was provided (mirrors inlineItemImages). */
function inlineBrandLogo(root: HTMLElement, dataUri: string | undefined): void {
  for (const el of root.querySelectorAll("[data-brand-logo]")) {
    el.setAttribute("src", dataUri && dataUri.trim() !== "" ? dataUri : PLACEHOLDER_IMAGE_DATA_URI);
  }
}

/** True when the markup uses any motion preset the theme declares as `runtime` (needs the lib). */
function usesRuntimeMotion(root: HTMLElement, theme: ResolvedTheme): boolean {
  const runtimeNames = new Set(theme.motion.filter((m) => m.kind === "runtime").map((m) => m.name));
  if (runtimeNames.size === 0) return false;
  for (const el of root.querySelectorAll("[data-motion]")) {
    if (runtimeNames.has(el.getAttribute("data-motion") ?? "")) return true;
  }
  return false;
}

function themeBlock(theme: ResolvedTheme): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(theme.tokens.colors))
    lines.push(`  --color-${name}: ${value};`);
  for (const [name, value] of Object.entries(theme.tokens.radius))
    lines.push(`  --radius-${name}: ${value};`);
  for (const [name, value] of Object.entries(theme.tokens.fontFamilies))
    lines.push(`  --font-${name}: ${value};`);
  // Type/spacing scale is deliberately NOT a theme token (free-paint engine — the painter picks
  // Tailwind utilities; type/spacing FEEL is directed by the theme's prompt, not a fixed scale).
  return `@theme {\n${lines.join("\n")}\n}`;
}

function baseStyles(theme: ResolvedTheme): string {
  const bg = theme.assets.backgrounds[0]?.dataUri;
  const fontFaces = theme.assets.fonts
    .map(
      (f) =>
        `@font-face{font-family:'${f.family}';font-weight:${f.weight ?? "normal"};src:url(${f.dataUri}) format('woff2');font-display:swap;}`,
    )
    .join("");
  const body = theme.tokens.fontFamilies["body"] ?? "system-ui, sans-serif";
  return (
    `${fontFaces}body{margin:0;background-color:var(--color-bg);color:var(--color-text);` +
    `font-family:${body};${bg ? `background-image:url(${bg});background-size:cover;` : ""}}`
  );
}

/**
 * Carousel/entrance glue (runs in the browser; pairs with the inlined motion.dev core). It
 * cross-fades the stacked slides of every `[data-motion="gallery-fade"]` on a timed loop and
 * entrance-fades other `[data-motion]` elements. Uses ONLY setInterval/animate/style — never
 * location/history/window.open — so it never trips the no-baked-player gate (§5.1).
 */
const CAROUSEL_GLUE =
  `(function(){var M=(typeof globalThis!=="undefined")&&globalThis.__ceMotion;if(!M||!M.animate)return;` +
  `var animate=M.animate;function params(s){var o={};(s||"").split(";").forEach(function(p){var k=p.split(":");` +
  `if(k.length===2){var v=parseFloat(k[1]);o[k[0].trim()]=isNaN(v)?k[1].trim():v;}});return o;}` +
  `function go(){` +
  // When the renderer asks for reduced motion (the QA browser does, the TV does not), skip the
  // reveal + carousel entirely: the HTML's default state IS the final frame — entrance elements
  // keep their natural opacity:1 and the carousel's first slide is opacity-100 by contract — so
  // the captured screenshot is the settled board, not the t=0 blank.
  `if(window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches)return;` +
  `document.querySelectorAll('[data-motion="gallery-fade"]').forEach(function(root){` +
  `var p=params(root.getAttribute("data-motion-params"));var interval=p.interval||5000;var fade=p.fade||800;` +
  `var slides=[];for(var i=0;i<root.children.length;i++){var c=root.children[i];` +
  `if(c.tagName==="IMG"||c.hasAttribute("data-slide"))slides.push(c);}if(slides.length<2)return;var idx=0;` +
  `slides.forEach(function(s,i){s.style.opacity=i===0?"1":"0";});setInterval(function(){var cur=slides[idx];` +
  `var nxt=slides[(idx+1)%slides.length];animate(cur,{opacity:[1,0]},{duration:fade/1000});` +
  `animate(nxt,{opacity:[0,1]},{duration:fade/1000});idx=(idx+1)%slides.length;},interval);});` +
  `document.querySelectorAll('[data-motion]:not([data-motion="gallery-fade"])').forEach(function(el,i){` +
  `animate(el,{opacity:[0,1]},{duration:0.6,delay:0.08*i});});}` +
  // Run only once the body is parsed: this <script> lives in <head>, so querying for
  // [data-motion] elements synchronously would match nothing and the carousel/entrance would never start.
  `if(document.readyState!=="loading"){go();}else{document.addEventListener("DOMContentLoaded",go);}})();`;

/** A tiny CSS-entrance stand-in for css-only screens (no motion lib needed). Carries the marker. */
const STANDIN_GLUE =
  `(function(){function go(){` +
  // Same reduced-motion guard as the runtime glue: under reduced motion the elements keep their
  // default opacity:1, so the capture shows the final state instead of fading in from blank.
  `if(window.matchMedia&&window.matchMedia("(prefers-reduced-motion: reduce)").matches)return;` +
  `try{var els=document.querySelectorAll('[data-motion]');els.forEach(function(el,i){` +
  `el.style.opacity='0';el.style.transition='opacity .6s ease';setTimeout(function(){el.style.opacity='1';},120*i);});}catch(e){}}` +
  // Same head-placement caveat as CAROUSEL_GLUE: defer to DOMContentLoaded so the body exists.
  `if(document.readyState!=="loading"){go();}else{document.addEventListener("DOMContentLoaded",go);}})();`;

/**
 * The inlined Motion runtime (D14). When a runtime-kind preset is used we inline the bundled
 * vanilla motion.dev core + the carousel glue; css-only screens get the lightweight stand-in.
 * Both carry `[data-motion-runtime]` (the §5.2 marker checkMotion requires for runtime motion).
 */
function motionRuntime(useRuntimeMotion: boolean): string {
  const js = useRuntimeMotion ? `${MOTION_LIB}\n${CAROUSEL_GLUE}` : STANDIN_GLUE;
  return `<script data-motion-runtime>${js}</script>`;
}

function document(css: string, body: string, runtime: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>${css}</style>${runtime}</head><body>${body}</body></html>`
  );
}

function resolveBase(): string {
  try {
    const require = createRequire(import.meta.url);
    // .../node_modules/tailwindcss/package.json → project root containing node_modules.
    return dirname(dirname(dirname(require.resolve("tailwindcss/package.json"))));
  } catch {
    return process.cwd();
  }
}
