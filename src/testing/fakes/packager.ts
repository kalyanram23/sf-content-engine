import { type HTMLElement, parse } from "node-html-parser";

import type { CanonicalItem, ResolvedTheme } from "../../domain/types";
import type { Packager, PackageRequest } from "../../ports/packager";
import { PLACEHOLDER_IMAGE_DATA_URI } from "../../util/placeholder-image";

/**
 * A deterministic packager: wraps the painter's markup in a self-contained document with an
 * inlined token stylesheet (CSS variables), the preset background as a data-URI, and an
 * inlined Motion-runtime marker (D14). It also resolves the painter's `data-img-item`
 * placeholders to data-URIs (mirroring the real packager) so structural QA against fake output
 * sees inlined, offline-safe images. Hex in this compiled stylesheet is legitimate and is not
 * token-linted (token-lint runs on the raw markup — D3). No external references.
 */
export class FakePackager implements Packager {
  package(request: PackageRequest): Promise<string> {
    return Promise.resolve(packageHtml(request.html, request.theme, request.items));
  }
}

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

function tokenStylesheet(theme: ResolvedTheme): string {
  // Mirror the real TailwindPackager's @theme namespaces so fake-backed tests reflect production:
  // --color-*, --radius-*, --font-* (no type/spacing scale tokens — those are prompt-directed).
  const vars: string[] = [];
  for (const [name, value] of Object.entries(theme.tokens.colors))
    vars.push(`--color-${name}:${value};`);
  for (const [name, value] of Object.entries(theme.tokens.radius))
    vars.push(`--radius-${name}:${value};`);
  for (const [name, value] of Object.entries(theme.tokens.fontFamilies))
    vars.push(`--font-${name}:${value};`);

  const bg = theme.assets.backgrounds[0]?.dataUri;
  const bodyBg = bg ? `background-image:url(${bg});background-size:cover;` : "";
  const body = theme.tokens.fontFamilies["body"] ?? "system-ui, sans-serif";

  return (
    `:root{${vars.join("")}}` +
    `body{margin:0;background-color:var(--color-bg);color:var(--color-text);` +
    `font-family:${body};${bodyBg}}` +
    `.text-text{color:var(--color-text);}.text-muted{color:var(--color-muted);}` +
    `.text-accent-strong{color:var(--color-accent-strong);}.text-price{color:var(--color-price);}`
  );
}

function packageHtml(html: string, theme: ResolvedTheme, items: readonly CanonicalItem[]): string {
  const root = parse(html);
  inlineItemImages(root, items);
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<style>${tokenStylesheet(theme)}</style>` +
    `<script data-motion-runtime>/* inlined Motion runtime (offline-safe) */</script>` +
    `</head><body>${root.toString()}</body></html>`
  );
}
