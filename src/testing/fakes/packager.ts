import type { ResolvedTheme } from "../../domain/types";
import type { Packager, PackageRequest } from "../../ports/packager";

/**
 * A deterministic packager: wraps the painter's markup in a self-contained document with an
 * inlined token stylesheet (CSS variables), the preset background as a data-URI, and an
 * inlined Motion-runtime marker (D14). Hex in this compiled stylesheet is legitimate and is
 * not token-linted (token-lint runs on the raw markup — D3). No external references.
 */
export class FakePackager implements Packager {
  package(request: PackageRequest): Promise<string> {
    return Promise.resolve(packageHtml(request.html, request.theme));
  }
}

function tokenStylesheet(theme: ResolvedTheme): string {
  const vars: string[] = [];
  for (const [name, value] of Object.entries(theme.tokens.colors))
    vars.push(`--color-${name}:${value};`);
  for (const [name, value] of Object.entries(theme.tokens.spacing))
    vars.push(`--space-${name}:${value};`);
  for (const [name, value] of Object.entries(theme.tokens.radius))
    vars.push(`--radius-${name}:${value};`);

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

function packageHtml(html: string, theme: ResolvedTheme): string {
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<style>${tokenStylesheet(theme)}</style>` +
    `<script data-motion-runtime>/* inlined Motion runtime (offline-safe) */</script>` +
    `</head><body>${html}</body></html>`
  );
}
