/**
 * carousel-demo.ts — falsification demo for the two auto-advancing photo carousels.
 *
 * The static polaroid collage overlapped its cards and could only show ~3–5 photos. This script
 * renders the SAME street-portrait board (1080×1920) but with the photo band replaced by a pure-CSS
 * auto-advancing carousel that flows through ALL 10 street photo candidates, in two variants:
 *
 *   crossfade → out/carousel-crossfade/   (Variant A: stacked-layer cross-dissolve deck)
 *   filmstrip → out/carousel-filmstrip/   (Variant B: sliding marquee of spaced polaroids)
 *
 * For each variant it writes:
 *   - board.html   the live self-contained board (open it to see real motion)
 *   - motion.webm  a ~10s real-time recording of it PLAYING (no seeking)
 *   - frame-{0,1,2}.png  three stills captured by SEEKING the CSS animations to fixed offsets
 *
 * No LLM/network for the composition — the block layout is authored deterministically here so the
 * demo is reproducible. (Photos are still fetched from their S3 URLs at render time, exactly like the
 * existing prototype.) The animation itself is CSS `@keyframes` only — no JS, no library, no CDN.
 *
 * Run:  npx tsx prototypes/component-vocab/carousel-demo.ts
 */

import { readdirSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser, type Page } from "playwright-core";

import type { Composition, PhotoMode } from "./catalog";
import { selectContent, RUNS } from "./compose";
import { render } from "./render";

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = join(HERE, "out");
const CANVAS = { width: 1080, height: 1920 } as const;

// Three seek offsets (ms) per variant that land on visibly different photos / strip positions.
const CROSSFADE_SEEKS = [1750, 5250, 8750]; // dwell 3.5s → photos 0, 1, 2 fully on screen
const FILMSTRIP_SEEKS = [1000, 16000, 31000]; // 45s loop → three distinct scroll positions
const RECORD_MS = 10_000; // real-time playback captured to webm

/** Author the street board deterministically, with ONE collage carrying ALL photo candidates. */
function buildComposition(photoIds: string[]): Composition {
  return {
    title: "Street & Sweets",
    blocks: [
      { type: "section", section: "Tiffins" },
      { type: "collage", itemIds: photoIds }, // ← the carousel: every street photo flows through
      { type: "section", section: "Dosa" },
      { type: "triBand", sections: ["Snack Box", "Chaat"] },
      { type: "section", section: "Desserts" },
      { type: "triBand", sections: ["Falooda'S", "Hot Drinks"] },
    ],
  };
}

/** setContent + wait for fonts and every image to actually decode (so photos aren't blank). */
async function prepPage(page: Page, html: string): Promise<void> {
  await page.setContent(html, { waitUntil: "load", timeout: 45_000 });
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await page.evaluate(() =>
    Promise.all(
      Array.from(document.images).map((img) =>
        img.complete ? Promise.resolve() : img.decode().catch(() => undefined),
      ),
    ).then(() => undefined),
  );
}

/** Record ~RECORD_MS of the board PLAYING in real time; flush + rename the webm to motion.webm. */
async function recordMotion(browser: Browser, html: string, outDir: string): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: CANVAS.width, height: CANVAS.height },
    deviceScaleFactor: 1,
    recordVideo: { dir: outDir, size: { width: CANVAS.width, height: CANVAS.height } },
  });
  const page = await context.newPage();
  await prepPage(page, html);
  const video = page.video();
  await page.waitForTimeout(RECORD_MS); // let the CSS animation PLAY — do not seek
  await context.close(); // flushes the video to disk
  if (video) {
    const src = await video.path();
    const dst = join(outDir, "motion.webm");
    try {
      rmSync(dst, { force: true });
    } catch {
      /* fresh dir */
    }
    renameSync(src, dst);
  }
}

/** Capture a still by SEEKING every CSS animation to `ms` (deterministic, no waiting for real time). */
async function seekFrame(
  browser: Browser,
  html: string,
  outPath: string,
  ms: number,
): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: CANVAS.width, height: CANVAS.height },
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    await prepPage(page, html);
    await page.evaluate((t) => {
      for (const a of document.getAnimations()) {
        a.pause();
        a.currentTime = t;
      }
    }, ms);
    await page.screenshot({ path: outPath });
  } finally {
    await context.close();
  }
}

async function runVariant(
  browser: Browser,
  mode: Exclude<PhotoMode, "collage">,
  seeks: number[],
): Promise<void> {
  const street = RUNS.find((r) => r.name === "menu-street-portrait");
  if (!street) throw new Error("menu-street-portrait config not found in RUNS");
  const { sections, photoCandidates } = selectContent(street);
  const photoIds = photoCandidates.map((c) => c.id);

  const comp = buildComposition(photoIds);
  // Portrait stack — no measurer needed (the measured-column path is landscape-only).
  const { html, fit, warnings } = await render(comp, {
    sections,
    photoCandidates,
    canvas: CANVAS,
    tagline: street.tagline,
    photoMode: mode,
  });
  for (const w of warnings) console.warn(`  render warning: ${w}`);

  const outDir = join(OUT, `carousel-${mode}`);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "board.html"), html);

  const kb = (Buffer.byteLength(html) / 1024).toFixed(1);
  console.log(`\n════════ carousel-${mode} ════════`);
  console.log(`photos cycled: ${photoIds.length}  (${photoIds.join(", ")})`);
  console.log(`register ${fit.register.name}  fill≈${(fit.fill * 100).toFixed(0)}%  html ${kb} KB`);

  console.log("  recording motion.webm (10s real-time)…");
  await recordMotion(browser, html, outDir);

  console.log(`  capturing 3 seeked stills at ${seeks.join(", ")} ms…`);
  for (let k = 0; k < seeks.length; k++) {
    await seekFrame(browser, html, join(outDir, `frame-${k}.png`), seeks[k]!);
  }

  const files = readdirSync(outDir).sort().join(", ");
  console.log(`  wrote out/carousel-${mode}/{${files}}`);
}

async function main(): Promise<void> {
  mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  try {
    await runVariant(browser, "crossfade", CROSSFADE_SEEKS);
    await runVariant(browser, "filmstrip", FILMSTRIP_SEEKS);
  } finally {
    await browser.close();
  }
  console.log("\ndone.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
