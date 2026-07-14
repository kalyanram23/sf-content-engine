/**
 * vocab-samples — render DENSITY-PROOF sample boards for a composition vocabulary, offline.
 *
 *   npm run vocab:samples -- <themeId> [--items 5,20,50] [--out vocab-samples]
 *
 * For each item count × orientation (portrait 1080×1920, landscape 1920×1080) this hand-authors a
 * composer response (no LLM, no API key), renders it through the REAL deterministic pipeline —
 * `renderComposed` (with the real Playwright measure port for landscape columns) → the real
 * Tailwind packager (fonts embedded, placeholders inlined) — and screenshots the packaged board
 * with headless Chromium. Output: `<out>/<themeId>/{portrait|landscape}-<n>.png` + an index.html
 * contact sheet. These screenshots are the per-theme visual sign-off artifact (D78) and the
 * 5–50-items-per-screen proof; the add-theme skill runs this command.
 *
 * Needs `npx playwright install chromium` once (same dependency as `npm run test:live`).
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import { renderComposed } from "../src/composition/renderer";
import { parseOrThrow } from "../src/domain/parse";
import { themePresetSchema } from "../src/domain/schemas";
import type { CanonicalItem, ResolvedTheme } from "../src/domain/types";
import type { CompositionBlock, CompositionResponse } from "../src/domain/contracts";
import type { VocabItem, VocabSection } from "../src/ports/vocabulary-registry";
import { PlaywrightBrowser } from "../src/adapters/playwright/browser";
import { TailwindPackager } from "../src/adapters/tailwind/packager";
import { builtinVocabularies } from "../src/vocabularies/index";

// ── fixture menu ─────────────────────────────────────────────────────────────────────────────────
const NAMES = [
  "Paneer 65",
  "Gunpowder Fries",
  "Chilli Garlic Momos",
  "Truffle Butter Naan",
  "Smoked Chicken Tikka",
  "Lamb Seekh Roll",
  "Market Fish Pollichathu",
  "Charred Broccoli Chaat",
  "Ghee Roast Wings",
  "Tandoori Half Chicken",
  "Malai Paneer Skewer",
  "Nihari Short Rib",
  "Dal Makhani (24hr)",
  "Wild Mushroom Pulao",
  "Railway Mutton Curry",
  "Kerala Prawn Moilee",
  "Butter Chicken Classic",
  "Smashed Aloo Tikki Burger",
  "Rose Falooda Sundae",
  "Filter Coffee Tiramisu",
  "Mango Sticky Rice Kulfi",
  "Masala Chai Affogato",
  "Salted Caramel Jalebi",
  "Watermelon Sol Kadhi Cooler",
  "Kokum Spritz",
];
const SECTION_TITLES = [
  "Small Plates",
  "Tandoor Mains",
  "Slow & Braised",
  "Breads & Rice",
  "Sweets & Shakes",
  "Coolers",
];

/** A 1-item colored-SVG data URI so photo cards render something visible offline. */
function photoDataUri(i: number): string {
  const hues = [18, 42, 8, 150, 268, 330];
  const h = hues[i % hues.length] ?? 18;
  const svg =
    `<svg xmlns='http://www.w3.org/2000/svg' width='400' height='300'>` +
    `<rect width='400' height='300' fill='hsl(${h},70%,55%)'/>` +
    `<circle cx='200' cy='150' r='90' fill='hsl(${h},80%,40%)'/>` +
    `<circle cx='200' cy='150' r='55' fill='hsl(${(h + 40) % 360},85%,65%)'/></svg>`;
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

interface Fixture {
  sections: VocabSection[];
  photoCandidates: VocabItem[];
  canonicalItems: CanonicalItem[];
  composition: CompositionResponse;
}

/** Distribute `count` items across sections the way real plans do (larger sections first). */
function sectionSizes(count: number): number[] {
  if (count <= 6) return [Math.ceil(count / 2), Math.floor(count / 2)].filter((n) => n > 0);
  const sections = count <= 24 ? 4 : 6;
  const base = Math.floor(count / sections);
  const sizes = Array.from({ length: sections }, () => base);
  for (let i = 0; i < count - base * sections; i++) sizes[i % sections]!++;
  return sizes;
}

function buildFixture(count: number): Fixture {
  const sizes = sectionSizes(count);
  const sections: VocabSection[] = [];
  const canonicalItems: CanonicalItem[] = [];
  let itemIdx = 0;
  sizes.forEach((size, s) => {
    const title = SECTION_TITLES[s % SECTION_TITLES.length]!;
    const items: VocabItem[] = [];
    for (let k = 0; k < size; k++) {
      const id = `it-${itemIdx}`;
      const name = NAMES[itemIdx % NAMES.length]!;
      const price = itemIdx % 9 === 8 ? null : 6.5 + ((itemIdx * 7) % 25) * 0.5;
      const hasImage = itemIdx % 3 === 0; // ~a third of the menu photographed
      // Per-section slots on the first two photo-carrying sections (exercises D75 slot cards).
      const slot = hasImage && s < 2 ? title : undefined;
      items.push({ id, name, price, hasImage, ...(slot !== undefined ? { slot } : {}) });
      canonicalItems.push({
        id,
        name,
        category: title.toLowerCase(),
        available: true,
        ...(price !== null ? { price } : {}),
        ...(hasImage ? { images: [photoDataUri(itemIdx)] } : {}),
      });
      itemIdx++;
    }
    sections.push({ title, items });
  });

  const photoCandidates = sections.flatMap((s) => s.items.filter((i) => i.hasImage));
  const blocks: CompositionBlock[] = [];
  // Group the two smallest sections when the board is big enough to justify a compact band.
  const grouped =
    sections.length >= 4
      ? [...sections].sort((a, b) => a.items.length - b.items.length).slice(0, 2)
      : [];
  const groupedTitles = new Set(grouped.map((s) => s.title));
  let bandPlaced = false;
  for (const s of sections) {
    if (groupedTitles.has(s.title)) continue;
    blocks.push({ kind: "section", section: s.title, sections: [], itemIds: [] });
    if (!bandPlaced && photoCandidates.length > 0) {
      blocks.push({
        kind: "photoBand",
        section: "",
        sections: [],
        itemIds: photoCandidates.slice(0, 3).map((c) => c.id),
      });
      bandPlaced = true;
    }
  }
  if (grouped.length === 2) {
    blocks.push({
      kind: "group",
      section: "",
      sections: grouped.map((s) => s.title),
      itemIds: [],
    });
  }
  return {
    sections,
    photoCandidates,
    canonicalItems,
    composition: { title: "Tandoor & Tonic", blocks },
  };
}

// ── render one sample ────────────────────────────────────────────────────────────────────────────
async function renderSample(
  themeId: string,
  theme: ResolvedTheme,
  fixture: Fixture,
  canvas: { width: number; height: number },
  browser: PlaywrightBrowser,
  packager: TailwindPackager,
): Promise<{ png: Buffer; note: string }> {
  const vocab = builtinVocabularies().get(themeId);
  if (!vocab) throw new Error(`no registered vocabulary "${themeId}"`);
  const result = await renderComposed({
    composition: fixture.composition,
    sections: fixture.sections,
    photoCandidates: fixture.photoCandidates,
    canvas,
    tagline: "Street kitchen · est. 2019",
    vocab,
    photoMode: vocab.defaultPhotoMode,
    colorTokens: theme.tokens.colors,
    fontFamilies: theme.tokens.fontFamilies,
    fontFaces: theme.assets.fonts,
    measure: (req) => browser.measure(req),
  });
  for (const w of result.warnings) console.warn(`  ⚠ ${w}`);
  const packaged = await packager.package({
    html: result.html,
    theme,
    items: fixture.canonicalItems,
  });
  const { screenshotBase64 } = await browser.render({
    html: packaged,
    viewport: { width: canvas.width, height: canvas.height, dpr: 1 },
  });
  const note =
    `register=${result.fit.register} fill=${result.fit.fill.toFixed(2)}` +
    (result.columnPlan
      ? ` columns=${result.columnPlan.columns} balanceΔ=${result.columnPlan.balanceDelta}px` +
        ` overflow=${result.columnPlan.overflow}`
      : "");
  return { png: Buffer.from(screenshotBase64, "base64"), note };
}

// ── CLI ──────────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const themeId = args.find((a) => !a.startsWith("--"));
  if (!themeId) {
    console.error("usage: npm run vocab:samples -- <themeId> [--items 5,20,50] [--out dir]");
    process.exit(1);
  }
  const flag = (name: string, dflt: string): string => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 && args[i + 1] ? args[i + 1]! : dflt;
  };
  const counts = flag("items", "5,20,50")
    .split(",")
    .map((s) => parseInt(s.trim(), 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  const outRoot = flag("out", "vocab-samples");

  const raw = await readFile(path.join("themes", `${themeId}.theme.json`), "utf8");
  const preset = parseOrThrow(themePresetSchema, JSON.parse(raw), `theme "${themeId}"`);
  const theme: ResolvedTheme = { ...preset, density: "balanced" };

  const browser = new PlaywrightBrowser();
  const packager = new TailwindPackager();
  const outDir = path.join(outRoot, themeId);
  await mkdir(outDir, { recursive: true });

  const shots: Array<{ file: string; note: string }> = [];
  for (const count of counts) {
    const fixture = buildFixture(count);
    for (const [label, canvas] of [
      ["portrait", { width: 1080, height: 1920 }],
      ["landscape", { width: 1920, height: 1080 }],
    ] as const) {
      console.log(`rendering ${themeId} ${label} @ ${count} items…`);
      const { png, note } = await renderSample(themeId, theme, fixture, canvas, browser, packager);
      const file = `${label}-${count}.png`;
      await writeFile(path.join(outDir, file), png);
      shots.push({ file, note: `${label} · ${count} items · ${note}` });
      console.log(`  → ${path.join(outDir, file)} (${note})`);
    }
  }

  const sheet =
    `<!DOCTYPE html><html><head><title>${themeId} vocab samples</title>` +
    `<style>body{font:14px system-ui;background:#222;color:#eee;margin:24px}` +
    `h1{font-size:20px}figure{display:inline-block;margin:12px;vertical-align:top}` +
    `img{max-height:640px;border:1px solid #555}figcaption{max-width:360px;padding-top:6px}</style>` +
    `</head><body><h1>${themeId} — density samples</h1>` +
    shots
      .map((s) => `<figure><img src="${s.file}"><figcaption>${s.note}</figcaption></figure>`)
      .join("") +
    `</body></html>`;
  await writeFile(path.join(outDir, "index.html"), sheet);
  console.log(`contact sheet: ${path.join(outDir, "index.html")}`);
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
