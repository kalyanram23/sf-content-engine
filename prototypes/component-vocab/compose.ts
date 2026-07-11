/**
 * compose.ts — the end-to-end falsification run, now PARAMETERIZED + ASPECT-AWARE.
 *
 *   select (raw menu + category slice) → Sonnet via OpenRouter structured outputs → validate →
 *   render (aspect-aware) → screenshot → metrics.
 *
 * A run is driven by a `RunConfig` (menu path, canvas, category slice + caps, output dir, title hint).
 * `main()` executes the `RUNS` array sequentially, reusing one browser across runs. Edit `RUNS` to
 * change the matrix (CLI parsing is intentionally omitted — this is a prototype).
 *
 * Run:  npx tsx prototypes/component-vocab/compose.ts
 * Needs OPENROUTER_API_KEY in .env at the repo root (loaded the same way scripts/try.ts does).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium, type Browser } from "playwright-core";

import {
  compositionJsonSchema,
  compositionSchema,
  type Canvas,
  type Composition,
  type MenuItem,
  type ResolvedSection,
} from "./catalog";
import { render } from "./render";

// ── paths / env ────────────────────────────────────────────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT = join(HERE, "out");
const MODEL = "anthropic/claude-sonnet-5";

try {
  process.loadEnvFile(join(ROOT, ".env"));
} catch {
  /* fall back to ambient environment */
}

// ── run configuration ────────────────────────────────────────────────────────────────────────────
interface RunConfig {
  name: string; // output subdir under out/
  menuPath: string; // relative to repo root
  canvas: Canvas;
  categories: string[]; // ordered category slice from the raw menu
  caps?: Record<string, number>; // per-category "keep first N items" cap (legibility; noted in metrics)
  tagline: string | null; // rendered verbatim next to the masthead title
  titleHint: string; // a one-line angle fed to the composer (it still picks the actual title)
  // Reuse a saved composition (path relative to out/) instead of calling the LLM — makes a
  // before/after comparison run deterministic and free (identical composition, only mechanism differs).
  frozenCompositionPath?: string;
}

// A "feast" slice: rice-forward mains. Big categories capped so one board stays legible.
const MAINS: string[] = ["Biryani", "Mandi", "Pulav", "Special Rice", "Non Veg Curries"];
const MAINS_CAPS: Record<string, number> = {
  Biryani: 10,
  Mandi: 10,
  Pulav: 10,
  "Non Veg Curries": 10,
  // Special Rice = 8 items, kept whole.
};

// A "street & sweets" slice: tiffins, snacks, chaat, sweets, drinks.
const STREET: string[] = [
  "Tiffins",
  "Dosa",
  "Snack Box",
  "Chaat",
  "Desserts",
  "Falooda'S",
  "Hot Drinks",
];
const STREET_CAPS: Record<string, number> = {
  Desserts: 10, // 15 items → keep first 10
  // the rest (Tiffins 13, Dosa 7, Snack Box 5, Chaat 2, Falooda'S 3, Hot Drinks 4) kept whole.
};

export const RUNS: RunConfig[] = [
  // ── continuation-cue hero (run: `npx tsx compose.ts cont`) ──
  {
    // SAME slice + canvas + composition as out/flow-mains-landscape, rendered through the NEW explicit
    // MEASURED columns path: sections split at self-computed break points and every column that opens
    // mid-section gets a subtle "<Section> (cont.)" cue. Reuses the frozen flow composition so it's a
    // pure mechanism-vs-mechanism comparison against the no-cue flow board.
    name: "cont-mains-landscape",
    menuPath: "samples/menu.json",
    canvas: { width: 1920, height: 1080 },
    categories: MAINS,
    caps: MAINS_CAPS,
    tagline: "Garma Garam!",
    titleHint: "a rice-and-meat feast board — biryani, mandi & curries",
    frozenCompositionPath: "flow-mains-landscape/composition.json",
  },
  // ── the flow hero + portrait control (run these two: `npx tsx compose.ts flow`) ──
  {
    // BEFORE/AFTER hero: same slice + canvas as the committed out/menu-mains-landscape, NEW balanced
    // multi-column row flow (sections split across column breaks at row granularity → bigger register).
    name: "flow-mains-landscape",
    menuPath: "samples/menu.json",
    canvas: { width: 1920, height: 1080 },
    categories: MAINS,
    caps: MAINS_CAPS,
    tagline: "Garma Garam!",
    titleHint: "a rice-and-meat feast board — biryani, mandi & curries",
  },
  {
    // Portrait control: confirms the stack path (full-width sections, internal 2-col price lists,
    // filmstrip band) is UNCHANGED by the landscape rewrite.
    name: "flow-street-portrait",
    menuPath: "samples/menu.json",
    canvas: { width: 1080, height: 1920 },
    categories: STREET,
    caps: STREET_CAPS,
    tagline: "Chai • Chaat • Sweets",
    titleHint: "a street-food & sweets board — tiffins, dosa, chaat, desserts, falooda",
  },
  // ── original reference boards (the committed befores; kept for comparison, not re-run) ──
  {
    name: "menu-mains-portrait",
    menuPath: "samples/menu.json",
    canvas: { width: 1080, height: 1920 },
    categories: MAINS,
    caps: MAINS_CAPS,
    tagline: "Garma Garam!",
    titleHint: "a rice-and-meat feast board — biryani, mandi & curries",
  },
  {
    name: "menu-mains-landscape",
    menuPath: "samples/menu.json",
    canvas: { width: 1920, height: 1080 },
    categories: MAINS,
    caps: MAINS_CAPS,
    tagline: "Garma Garam!",
    titleHint: "a rice-and-meat feast board — biryani, mandi & curries",
  },
  {
    name: "menu-street-portrait",
    menuPath: "samples/menu.json",
    canvas: { width: 1080, height: 1920 },
    categories: STREET,
    caps: STREET_CAPS,
    tagline: "Chai • Chaat • Sweets",
    titleHint: "a street-food & sweets board — tiffins, dosa, chaat, desserts, falooda",
  },
];

// ── raw-menu selector (no plan exists — this stands in for coverage/imageSlot) ────────────────────
interface RawMenuItem {
  id: string;
  name: string;
  price: number | null;
  category: string;
  available?: boolean;
  images?: string[];
}

/** Strip menu annotation markers (a trailing " *") — a clean of source data, not invented copy. */
const cleanName = (s: string): string => s.replace(/\s*\*+\s*$/, "").trim();

interface SelectedContent {
  sections: ResolvedSection[];
  photoCandidates: MenuItem[];
  digest: string;
  appliedCaps: Array<{ category: string; kept: number; total: number }>;
}

export function selectContent(config: RunConfig): SelectedContent {
  const menu: RawMenuItem[] = JSON.parse(readFileSync(join(ROOT, config.menuPath), "utf8"));
  const byCategory = new Map<string, RawMenuItem[]>();
  for (const it of menu) {
    if (!byCategory.has(it.category)) byCategory.set(it.category, []);
    byCategory.get(it.category)!.push(it);
  }

  const caps = config.caps ?? {};
  const sections: ResolvedSection[] = [];
  const photoCandidates: MenuItem[] = [];
  const appliedCaps: Array<{ category: string; kept: number; total: number }> = [];

  for (const category of config.categories) {
    const rows = byCategory.get(category) ?? [];
    const cap = caps[category] ?? rows.length;
    const chosen = rows.slice(0, cap);
    if (cap < rows.length) appliedCaps.push({ category, kept: chosen.length, total: rows.length });

    const items: MenuItem[] = chosen.map((m) => ({
      id: m.id,
      name: cleanName(m.name),
      price: m.price ?? null,
    }));
    sections.push({ title: cleanName(category), items });

    for (const m of chosen) {
      if (m.images && m.images[0]) {
        photoCandidates.push({
          id: m.id,
          name: cleanName(m.name),
          price: m.price ?? null,
          imageUrl: m.images[0],
        });
      }
    }
  }

  // ── compact digest (judgment input only; no ids to echo except collage picks) ──
  const secLines = sections
    .map(
      (s) =>
        `Section "${s.title}" (${s.items.length}): ` +
        s.items
          .map((it) => `${it.name} ${it.price === null ? "MP" : "$" + it.price.toFixed(2)}`)
          .join("; "),
    )
    .join("\n");
  const photoLines = photoCandidates.map((c) => `  ${c.id} = ${c.name}`).join("\n");
  const digest =
    `BOARD ANGLE: ${config.titleHint}\n\n` +
    `BOARD CONTENT — render every section below exactly once:\n${secLines}\n\n` +
    `PHOTO LIBRARY — the only ids you may put in a collage:\n${photoLines}`;

  return { sections, photoCandidates, digest, appliedCaps };
}

// ── prompt (dimensions reflect the actual run canvas) ─────────────────────────────────────────────
function buildSystem(canvas: Canvas): string {
  const orient = canvas.height > canvas.width ? "portrait" : "landscape";
  return `You are the composer for a roadside-dhaba menu POSTER (${canvas.width}×${canvas.height} ${orient}). You do NOT write HTML or CSS. You emit a small JSON "composition" that a deterministic renderer expands into the final board using a fixed set of hand-designed components. The renderer arranges your blocks to fill this canvas (stacking them on a tall portrait, or flowing them into balanced newspaper columns on a wide landscape one) — you never think about columns or sizes.

The board masthead (title) and the truck-art stripe frame are drawn automatically — you never place them. You choose only the BODY blocks and their order.

Block vocabulary (each block's "type" + the ONE field it uses):
- "section"  → { "type":"section", "section":"<exact section title>" }  — one numbered section (header + price list).
- "triBand"  → { "type":"triBand", "sections":["<title>","<title>",...] } — 2 or 3 SMALL sections grouped together in one compact band. Use this to group the short sections.
- "collage"  → { "type":"collage", "itemIds":["<id>",...] } — a strip of 3–5 tilted polaroid photos. Pick ids ONLY from the photo library.

You decide JUDGMENT ONLY: the block order, which sections are standalone vs grouped into a triBand, where the photo collage sits, which 3–5 photos it shows, and the board title. You decide NO sizes, columns, fonts, or coordinates — the renderer computes those to fill the canvas.

Compose it like the gold reference: lead with the biggest/most important sections, put ONE photo collage in to break up the text, and gather the small sections (≈2–4 items) into a triBand. Every section must appear exactly once (as a "section" or inside a "triBand"). Keep the JSON tiny.`;
}

// ── OpenRouter structured-output call ──────────────────────────────────────────────────────────────
interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}
async function callLLM(
  apiKey: string,
  system: string,
  digest: string,
  repairNote: string | null,
): Promise<{ content: string; usage: Usage }> {
  const messages = [
    { role: "system", content: system },
    {
      role: "user",
      content:
        digest +
        (repairNote
          ? `\n\nYour previous JSON was rejected: ${repairNote}\nReturn corrected JSON.`
          : ""),
    },
  ];
  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/content-engine",
      "X-Title": "component-vocab-phase0",
    },
    body: JSON.stringify({
      model: MODEL,
      messages,
      temperature: 0.3,
      max_tokens: 2000,
      response_format: {
        type: "json_schema",
        json_schema: { name: "composition", strict: true, schema: compositionJsonSchema() },
      },
    }),
  });
  if (!res.ok) {
    throw new Error(`OpenRouter ${res.status}: ${await res.text()}`);
  }
  const json = (await res.json()) as {
    choices: Array<{ message: { content: string } }>;
    usage?: Usage;
  };
  return { content: json.choices[0]?.message?.content ?? "", usage: json.usage ?? {} };
}

// ── measure pass (landscape flow) ─────────────────────────────────────────────────────────────────
// Load the off-screen measure document, WAIT FOR THE FONTS (Shrikhand/Archivo — heights are wrong if
// they haven't loaded), then read each data-mk element's rendered height. Runs in the SAME browser as
// the final screenshot; the renderer partitions explicit columns off these true heights.
async function measureHeights(
  browser: Browser,
  html: string,
  canvas: Canvas,
): Promise<Record<string, number>> {
  const context = await browser.newContext({
    viewport: { width: canvas.width, height: Math.max(canvas.height, 3000) },
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 45000 });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    return await page.evaluate(() => {
      const out: Record<string, number> = {};
      document.querySelectorAll("[data-mk]").forEach((el) => {
        const key = el.getAttribute("data-mk");
        if (key) out[key] = (el as HTMLElement).getBoundingClientRect().height;
      });
      return out;
    });
  } finally {
    await context.close();
  }
}

// ── screenshot (browser reused across runs; one context per run at the run's viewport) ─────────────
async function screenshot(
  browser: Browser,
  html: string,
  canvas: Canvas,
  outPath: string,
): Promise<void> {
  const context = await browser.newContext({
    viewport: { width: canvas.width, height: canvas.height },
    deviceScaleFactor: 1,
  });
  try {
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: "load", timeout: 45000 });
    await page.evaluate(() => document.fonts.ready.then(() => undefined));
    await page.evaluate(
      () =>
        Promise.all(
          Array.from(document.images).map((img) =>
            img.complete ? Promise.resolve() : img.decode().catch(() => undefined),
          ),
        ).then(() => undefined),
    );
    await page.waitForTimeout(600);
    await page.screenshot({ path: outPath });
  } finally {
    await context.close();
  }
}

// ── one run ────────────────────────────────────────────────────────────────────────────────────────
function blockSeqOf(blocks: Composition["blocks"]): string {
  return blocks
    .map((b) =>
      b.type === "section"
        ? `section(${b.section})`
        : b.type === "triBand"
          ? `triBand(${(b.sections ?? []).join("+")})`
          : `collage(${(b.itemIds ?? []).join(",")})`,
    )
    .join(" → ");
}

async function runOne(config: RunConfig, apiKey: string, browser: Browser): Promise<void> {
  const outDir = join(OUT, config.name);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const orient = config.canvas.height > config.canvas.width ? "portrait" : "landscape";
  console.log(`\n════════ ${config.name}  (${config.canvas.width}×${config.canvas.height} ${orient}) ════════`);

  const { sections, photoCandidates, digest, appliedCaps } = selectContent(config);
  const itemCount = sections.reduce((n, s) => n + s.items.length, 0);
  console.log(
    `slice: ${config.categories.join(", ")}  →  ${itemCount} items across ${sections.length} sections, ${photoCandidates.length} photo candidates`,
  );
  if (appliedCaps.length) {
    console.log(
      `caps: ${appliedCaps.map((c) => `${c.category} kept ${c.kept}/${c.total}`).join("; ")}`,
    );
  }
  console.log(`digest ${Buffer.byteLength(digest)} bytes`);

  const system = buildSystem(config.canvas);
  const runStart = Date.now();

  // Composition: reuse a frozen one (deterministic before/after) or ask the LLM (one repair retry).
  let comp: Composition | null = null;
  let usage: Usage = {};
  let llmMs = 0;
  if (config.frozenCompositionPath) {
    const raw = readFileSync(join(OUT, config.frozenCompositionPath), "utf8");
    comp = compositionSchema.parse(JSON.parse(raw));
    console.log(`using frozen composition ${config.frozenCompositionPath} (no LLM call)`);
  } else {
    let repairNote: string | null = null;
    for (let attempt = 0; attempt < 2 && !comp; attempt++) {
      const t0 = Date.now();
      const { content, usage: u } = await callLLM(apiKey, system, digest, repairNote);
      llmMs += Date.now() - t0;
      usage = u;
      const parsed = compositionSchema.safeParse(JSON.parse(content));
      if (parsed.success) {
        comp = parsed.data;
      } else {
        repairNote = JSON.stringify(parsed.error.issues.slice(0, 5));
        console.warn(`  attempt ${attempt + 1} validation failed: ${repairNote}`);
      }
    }
  }
  if (!comp) throw new Error(`[${config.name}] composition failed validation after retry`);

  const compBytes = Buffer.byteLength(JSON.stringify(comp));
  const llmSeq = blockSeqOf(comp.blocks);
  console.log(`composition ${compBytes} bytes  title="${comp.title}"`);
  console.log(`LLM blocks: ${llmSeq}`);

  // render (aspect-aware). Filmstrip is the default photo band for these boards (edge-faded marquee).
  // The landscape flow measures its rows/headers in `browser` (fonts loaded) to partition explicit
  // columns; the measure runs in the SAME browser as the screenshot below.
  const measure = (measureHtml: string): Promise<Record<string, number>> =>
    measureHeights(browser, measureHtml, config.canvas);
  const { html, finalBlocks, fit, warnings, columnPlan } = await render(
    comp,
    {
      sections,
      photoCandidates,
      canvas: config.canvas,
      tagline: config.tagline,
      photoMode: "filmstrip",
    },
    measure,
  );
  for (const w of warnings) console.warn(`  render warning: ${w}`);
  const renderedSeq = blockSeqOf(finalBlocks);
  console.log(
    `layout: ${fit.layout.mode}${fit.layout.mode === "columns" ? `(${fit.layout.columns}col)` : ""}  register ${fit.register.name}  fill≈${(fit.fill * 100).toFixed(0)}%`,
  );
  if (columnPlan) {
    console.log(
      `columns: heights=[${columnPlan.columnHeights.join(", ")}]px  avail=${columnPlan.avail}px  ` +
        `delta=${columnPlan.balanceDelta}px  overflow=${columnPlan.overflow}`,
    );
    console.log(
      `cues: ${
        columnPlan.cues.length
          ? columnPlan.cues.map((c) => `col${c.column} "${c.section} (cont.)"`).join("; ")
          : "(none)"
      }`,
    );
  }
  console.log(`rendered: ${renderedSeq}`);

  writeFileSync(join(outDir, "composition.json"), JSON.stringify(comp, null, 2));
  writeFileSync(join(outDir, "board.html"), html);

  // screenshot
  console.log("  rendering screenshot…");
  await screenshot(browser, html, config.canvas, join(outDir, "board.png"));

  const totalMs = Date.now() - runStart;
  const metrics = {
    name: config.name,
    model: MODEL,
    canvas: config.canvas,
    orientation: orient,
    categories: config.categories,
    appliedCaps,
    itemCount,
    photoCandidates: photoCandidates.length,
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    llmMs,
    totalMs,
    compositionBytes: compBytes,
    htmlBytes: Buffer.byteLength(html),
    layoutMode: fit.layout.mode,
    layoutColumns: fit.layout.columns,
    register: fit.register.name,
    fillPct: Math.round(fit.fill * 100),
    title: comp.title,
    llmBlockSequence: llmSeq,
    renderedBlockSequence: renderedSeq,
    ...(columnPlan ? { columnPlan } : {}),
  };
  writeFileSync(join(outDir, "metrics.json"), JSON.stringify(metrics, null, 2));
  console.log(`  wrote out/${config.name}/{board.html,board.png,composition.json,metrics.json}`);
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    console.error("Missing OPENROUTER_API_KEY (put it in .env at the repo root).");
    process.exit(1);
  }
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

  // Optional filter: `npx tsx compose.ts mains-portrait street-square` runs only matching names.
  const filters = process.argv.slice(2);
  const runs = filters.length
    ? RUNS.filter((r) => filters.some((f) => r.name.includes(f)))
    : RUNS;
  console.log(`running ${runs.length} board(s): ${runs.map((r) => r.name).join(", ")}`);

  const browser = await chromium.launch();
  try {
    for (const config of runs) {
      await runOne(config, apiKey, browser);
    }
  } finally {
    await browser.close();
  }
  console.log("\ndone.");
}

// Run only when executed directly (so tests can import selectContent/RUNS without triggering a run).
const invokedDirectly = process.argv[1] === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
