/**
 * Embeds a theme's declared typefaces as offline-safe woff2 data-URIs into its theme file's
 * `assets.fonts`, so the packager emits real @font-face rules and the declared fonts actually
 * render (instead of falling back to system fonts). Fetches the latin woff2 from Google Fonts at
 * build time. Run: `npm run embed:fonts` (network needed once; the result is committed).
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const THEME = resolve(here, "..", "themes", "botanical.theme.json");

// family name (must match theme.tokens.fontFamilies' first name) → Google Fonts spec.
const FONTS: { family: string; spec: string }[] = [
  { family: "Cormorant Garamond", spec: "Cormorant+Garamond:wght@600" },
  { family: "Inter", spec: "Inter:wght@500" },
];

// A modern-browser UA so the CSS API returns woff2 (the smallest, widely supported format).
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

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

async function main(): Promise<void> {
  const theme = JSON.parse(readFileSync(THEME, "utf8")) as {
    assets: { fonts: { family: string; dataUri: string }[] };
  };
  const fonts: { family: string; dataUri: string }[] = [];
  for (const f of FONTS) {
    const dataUri = await fetchWoff2DataUri(f.spec);
    fonts.push({ family: f.family, dataUri });
    console.warn(`embed-fonts: ${f.family} → ${Math.round(dataUri.length / 1024)} KB data-URI`);
  }
  theme.assets.fonts = fonts;
  writeFileSync(THEME, JSON.stringify(theme, null, 2) + "\n", "utf8");
  console.warn(`embed-fonts: wrote ${fonts.length} font(s) into themes/botanical.theme.json`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
