import { createRequire } from "node:module";
import { dirname } from "node:path";

import { compile } from "@tailwindcss/node";
import { parse } from "node-html-parser";

import { PackagingError } from "../../domain/errors";
import type { ResolvedTheme } from "../../domain/types";
import type { Packager, PackageRequest } from "../../ports/packager";

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
      const candidates = extractCandidates(request.html);
      const input = `@import "tailwindcss";\n${themeBlock(request.theme)}`;
      const compiler = await compile(input, { base: resolveBase(), onDependency: () => {} });
      const utilities = compiler.build(candidates);
      const css = `${utilities}\n${baseStyles(request.theme)}`;
      return document(css, request.html);
    } catch (error) {
      if (error instanceof PackagingError) throw error;
      throw new PackagingError("Tailwind packaging failed.", { cause: error });
    }
  }
}

function extractCandidates(html: string): string[] {
  const root = parse(html);
  const set = new Set<string>();
  for (const el of root.querySelectorAll("[class]")) {
    for (const cls of (el.getAttribute("class") ?? "").split(/\s+/)) if (cls) set.add(cls);
  }
  return [...set];
}

function themeBlock(theme: ResolvedTheme): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(theme.tokens.colors))
    lines.push(`  --color-${name}: ${value};`);
  for (const [name, value] of Object.entries(theme.tokens.radius))
    lines.push(`  --radius-${name}: ${value};`);
  for (const [name, value] of Object.entries(theme.tokens.fontFamilies))
    lines.push(`  --font-${name}: ${value};`);
  return `@theme {\n${lines.join("\n")}\n}`;
}

function baseStyles(theme: ResolvedTheme): string {
  const bg = theme.assets.backgrounds[0]?.dataUri;
  const fontFaces = theme.assets.fonts
    .map((f) => `@font-face{font-family:${f.family};src:url(${f.dataUri});}`)
    .join("");
  const body = theme.tokens.fontFamilies["body"] ?? "system-ui, sans-serif";
  return (
    `${fontFaces}body{margin:0;background-color:var(--color-bg);color:var(--color-text);` +
    `font-family:${body};${bg ? `background-image:url(${bg});background-size:cover;` : ""}}`
  );
}

/** A v1 stand-in Motion runtime: applies a CSS entrance per data-motion. Marked for the QA check. */
const MOTION_RUNTIME = `<script data-motion-runtime>
(function(){try{var els=document.querySelectorAll('[data-motion]');els.forEach(function(el,i){el.style.opacity='0';el.style.transition='opacity .6s ease';setTimeout(function(){el.style.opacity='1';},120*i);});}catch(e){}})();
</script>`;

function document(css: string, body: string): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1">` +
    `<style>${css}</style>${MOTION_RUNTIME}</head><body>${body}</body></html>`
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
