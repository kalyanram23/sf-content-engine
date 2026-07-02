/**
 * Embeds each theme's declared typefaces as offline-safe woff2 data-URIs into its theme file's
 * `assets.fonts`, so the packager emits real @font-face rules and the declared fonts actually
 * render (instead of falling back to system fonts). Fetches the latin woff2 from Google Fonts at
 * build time. Run: `npm run embed:fonts` (all themes) or `npm run embed:fonts -- <id> [<id>...]`
 * to limit to specific theme ids. Network needed once; the result is committed.
 *
 * Families are read from each theme's `tokens.fontFamilies` (the first single-quoted name in each
 * stack) and looked up in FONT_SPECS below for the Google Fonts spec + weight. A family embedded
 * at two weights (e.g. a body face at 500 and 700) yields two `assets.fonts` entries carrying
 * distinct `weight`s, so the packager's @font-face rules don't collide at `normal`.
 */
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const themesDir = resolve(here, "..", "themes");

/**
 * family name (must match a theme's `tokens.fontFamilies` first quoted name) → the Google Fonts
 * spec(s) + `font-weight` to embed. A single-weight display family (Anton, Archivo Black,
 * Shrikhand) has no `wght@` axis and no `weight` (renders `normal`). Families NOT listed here
 * fall back to a plain regular fetch with a warning.
 */
const FONT_SPECS: Record<string, { spec: string; weight?: string }[]> = {
  "Cormorant Garamond": [{ spec: "Cormorant+Garamond:wght@600", weight: "600" }],
  Inter: [{ spec: "Inter:wght@500", weight: "500" }],
  Anton: [{ spec: "Anton" }],
  "Archivo Black": [{ spec: "Archivo+Black" }],
  "Space Grotesk": [
    { spec: "Space+Grotesk:wght@500", weight: "500" },
    { spec: "Space+Grotesk:wght@700", weight: "700" },
  ],
  Shrikhand: [{ spec: "Shrikhand" }],
  Archivo: [
    { spec: "Archivo:wght@500", weight: "500" },
    { spec: "Archivo:wght@700", weight: "700" },
  ],
};

// A modern-browser UA so the CSS API returns woff2 (the smallest, widely supported format).
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

interface ThemeFile {
  id: string;
  tokens: { fontFamilies: Record<string, string> };
  assets: { fonts: { family: string; dataUri: string; weight?: string }[] };
}

async function fetchWoff2DataUri(spec: string): Promise<string> {
  const cssUrl = `https://fonts.googleapis.com/css2?family=${spec}&display=swap`;
  const css = await (await fetch(cssUrl, { headers: { "User-Agent": UA } })).text();
  // Prefer a latin (non-subset) block; else take the first woff2 url in the CSS.
  const blocks = css.split("@font-face");
  const latin = blocks.find((b) => /unicode-range:\s*U\+0000/.test(b)) ?? blocks.join("");
  const m = latin.match(/url\((https:\/\/[^)]+\.woff2)\)/);
  if (!m || !m[1]) throw new Error(`no woff2 url found for ${spec}`);
  const buf = Buffer.from(await (await fetch(m[1])).arrayBuffer());
  return `data:font/woff2;base64,${buf.toString("base64")}`;
}

/** The first single-quoted family name in each fontFamilies stack, deduped and order-preserved. */
function familiesOf(theme: ThemeFile): string[] {
  const names: string[] = [];
  for (const stack of Object.values(theme.tokens.fontFamilies)) {
    const m = stack.match(/'([^']+)'/);
    if (m?.[1] && !names.includes(m[1])) names.push(m[1]);
  }
  return names;
}

async function embedTheme(file: string): Promise<void> {
  const path = resolve(themesDir, file);
  const theme = JSON.parse(readFileSync(path, "utf8")) as ThemeFile;
  const fonts: { family: string; dataUri: string; weight?: string }[] = [];
  for (const family of familiesOf(theme)) {
    const faces = FONT_SPECS[family];
    if (!faces) {
      console.warn(
        `embed-fonts: no spec for "${family}" in ${file} — fetching regular; add it to FONT_SPECS for a specific weight.`,
      );
    }
    for (const face of faces ?? [{ spec: family.replace(/ /g, "+") }]) {
      const dataUri = await fetchWoff2DataUri(face.spec);
      fonts.push({
        family,
        dataUri,
        ...(face.weight !== undefined ? { weight: face.weight } : {}),
      });
      console.warn(
        `embed-fonts: ${family}${face.weight ? ` @${face.weight}` : ""} → ${Math.round(dataUri.length / 1024)} KB (${file})`,
      );
    }
  }
  theme.assets.fonts = fonts;
  writeFileSync(path, JSON.stringify(theme, null, 2) + "\n", "utf8");
  console.warn(`embed-fonts: wrote ${fonts.length} font(s) into themes/${file}`);
}

async function main(): Promise<void> {
  const only = process.argv.slice(2);
  const files = readdirSync(themesDir).filter((f) => f.endsWith(".theme.json"));
  const selected =
    only.length > 0 ? files.filter((f) => only.includes(f.replace(/\.theme\.json$/, ""))) : files;
  if (selected.length === 0) {
    throw new Error(
      `no matching theme files in themes/ (looked for ${only.length > 0 ? only.join(", ") : "*.theme.json"}).`,
    );
  }
  for (const file of selected) await embedTheme(file);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
