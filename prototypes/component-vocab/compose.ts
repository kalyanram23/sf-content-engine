/**
 * compose.ts — the end-to-end falsification run.
 *
 *   digest (plan + menu) → Sonnet via OpenRouter structured outputs → validate → render → screenshot.
 *
 * Run:  npx tsx prototypes/component-vocab/compose.ts
 * Needs OPENROUTER_API_KEY in .env at the repo root (loaded the same way scripts/try.ts does).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { chromium } from "playwright-core";

import {
  compositionJsonSchema,
  compositionSchema,
  type Canvas,
  type Composition,
  type MenuItem,
  type ResolvedSection,
} from "./catalog";
import { render } from "./render";

// ── paths ────────────────────────────────────────────────────────────────────────────────────────
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..", "..");
const OUT = join(HERE, "out");
const CANVAS: Canvas = { width: 1080, height: 1920 };
const MODEL = "anthropic/claude-sonnet-5";

// ── env (mirrors scripts/try.ts) ───────────────────────────────────────────────────────────────────
try {
  process.loadEnvFile(join(ROOT, ".env"));
} catch {
  /* fall back to ambient environment */
}

interface RawMenuItem {
  id: string;
  name: string;
  price: number | null;
  images?: string[];
}

/** Strip menu annotation markers (a trailing " *") — a clean of source data, not invented copy. */
const cleanName = (s: string): string => s.replace(/\s*\*+\s*$/, "").trim();

function loadContent(): {
  sections: ResolvedSection[];
  photoCandidates: MenuItem[];
  digest: string;
  tagline: string | null;
} {
  const plan = JSON.parse(readFileSync(join(ROOT, "real-output", "plan.json"), "utf8"));
  const menu: RawMenuItem[] = JSON.parse(
    readFileSync(join(ROOT, "samples", "menu-dhaba-2board.json"), "utf8"),
  );
  const screen = plan.screens[1];
  const byId = new Map(menu.map((m) => [m.id, m]));

  const sections: ResolvedSection[] = screen.sections.map(
    (sec: { title: string; items: string[] }) => ({
      title: sec.title,
      items: sec.items
        .map((id) => byId.get(id))
        .filter((m): m is RawMenuItem => Boolean(m))
        .map((m) => ({ id: m.id, name: cleanName(m.name), price: m.price ?? null })),
    }),
  );

  const photoCandidates: MenuItem[] = (screen.imageSlot?.items ?? [])
    .map((id: string) => byId.get(id))
    .filter((m: RawMenuItem | undefined): m is RawMenuItem => Boolean(m && m.images && m.images[0]))
    .map((m: RawMenuItem) => ({
      id: m.id,
      name: cleanName(m.name),
      price: m.price ?? null,
      imageUrl: m.images![0],
    }));

  // ── compact digest (judgment input only; no ids to echo except collage picks) ──
  const secLines = sections
    .map(
      (s) =>
        `Section "${s.title}" (${s.items.length}): ` +
        s.items.map((it) => `${it.name} ${it.price === null ? "MP" : "$" + it.price.toFixed(2)}`).join("; "),
    )
    .join("\n");
  const photoLines = photoCandidates.map((c) => `  ${c.id} = ${c.name}`).join("\n");
  const digest =
    `BOARD CONTENT — render every section below exactly once, top to bottom:\n${secLines}\n\n` +
    `PHOTO LIBRARY — the only ids you may put in a collage:\n${photoLines}`;

  return { sections, photoCandidates, digest, tagline: "Garma Garam!" };
}

// ── prompt ──────────────────────────────────────────────────────────────────────────────────────
const SYSTEM = `You are the composer for a roadside-dhaba menu POSTER (1080×1920 portrait). You do NOT write HTML or CSS. You emit a small JSON "composition" that a deterministic renderer expands into the final board using a fixed set of hand-designed components.

The board masthead (title) and the truck-art stripe frame are drawn automatically — you never place them. You choose only the BODY blocks and their order.

Block vocabulary (each block's "type" + the ONE field it uses):
- "section"  → { "type":"section", "section":"<exact section title>" }  — one full-width numbered section (header + price list).
- "triBand"  → { "type":"triBand", "sections":["<title>","<title>",...] } — 2 or 3 SMALL sections side by side in one compact bottom band. Use this to group the short sections.
- "collage"  → { "type":"collage", "itemIds":["<id>",...] } — a strip of 3–5 tilted polaroid photos. Pick ids ONLY from the photo library.

You decide JUDGMENT ONLY: the block order, which sections are full-width vs grouped into a triBand, where the photo collage sits, which 3–5 photos it shows, and the board title. You decide NO sizes, columns, fonts, or coordinates — the renderer computes those to fill the canvas.

Compose it like the gold reference: lead with the biggest/most important sections full-width, put ONE photo collage in the middle to break up the text, and gather the small sections (≈2–4 items) into a triBand near the bottom. Every section must appear exactly once (as a "section" or inside a "triBand"). Keep the JSON tiny.`;

// ── OpenRouter structured-output call ──────────────────────────────────────────────────────────────
interface Usage {
  prompt_tokens?: number;
  completion_tokens?: number;
}
async function callLLM(
  apiKey: string,
  digest: string,
  repairNote: string | null,
): Promise<{ content: string; usage: Usage }> {
  const messages = [
    { role: "system", content: SYSTEM },
    {
      role: "user",
      content:
        digest +
        (repairNote ? `\n\nYour previous JSON was rejected: ${repairNote}\nReturn corrected JSON.` : ""),
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

// ── screenshot ──────────────────────────────────────────────────────────────────────────────────
async function screenshot(html: string, outPath: string): Promise<void> {
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext({
      viewport: { width: CANVAS.width, height: CANVAS.height },
      deviceScaleFactor: 1,
    });
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
    await browser.close();
  }
}

// ── main ────────────────────────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    console.error("Missing OPENROUTER_API_KEY (put it in .env at the repo root).");
    process.exit(1);
  }
  if (!existsSync(OUT)) mkdirSync(OUT, { recursive: true });

  const { sections, photoCandidates, digest, tagline } = loadContent();
  console.log(`Digest (${Buffer.byteLength(digest)} bytes):\n${digest}\n`);
  console.log(`JSON schema:\n${JSON.stringify(compositionJsonSchema())}\n`);

  const runStart = Date.now();

  // LLM (one repair retry on Zod-validation failure)
  let comp: Composition | null = null;
  let usage: Usage = {};
  let llmMs = 0;
  let repairNote: string | null = null;
  for (let attempt = 0; attempt < 2 && !comp; attempt++) {
    const t0 = Date.now();
    const { content, usage: u } = await callLLM(apiKey, digest, repairNote);
    llmMs += Date.now() - t0;
    usage = u;
    const parsed = compositionSchema.safeParse(JSON.parse(content));
    if (parsed.success) {
      comp = parsed.data;
    } else {
      repairNote = JSON.stringify(parsed.error.issues.slice(0, 5));
      console.warn(`attempt ${attempt + 1} validation failed: ${repairNote}`);
    }
  }
  if (!comp) throw new Error("composition failed validation after retry");

  const compBytes = Buffer.byteLength(JSON.stringify(comp));
  console.log(`Composition (${compBytes} bytes):\n${JSON.stringify(comp, null, 2)}\n`);

  // render
  const { html, finalBlocks, fit, warnings } = render(comp, {
    sections,
    photoCandidates,
    canvas: CANVAS,
    tagline,
  });
  for (const w of warnings) console.warn(`render warning: ${w}`);
  const blockSeq = finalBlocks
    .map((b) =>
      b.type === "section"
        ? `section(${b.section})`
        : b.type === "triBand"
          ? `triBand(${(b.sections ?? []).join("+")})`
          : `collage(${(b.itemIds ?? []).join(",")})`,
    )
    .join(" → ");
  console.log(`Register: ${fit.register.name}  fill≈${(fit.fill * 100).toFixed(0)}%`);
  console.log(`Blocks: ${blockSeq}\n`);

  writeFileSync(join(OUT, "composition.json"), JSON.stringify(comp, null, 2));
  writeFileSync(join(OUT, "board.html"), html);

  // screenshot
  console.log("rendering screenshot…");
  await screenshot(html, join(OUT, "board.png"));

  const totalMs = Date.now() - runStart;
  const metrics = {
    model: MODEL,
    promptTokens: usage.prompt_tokens ?? null,
    completionTokens: usage.completion_tokens ?? null,
    llmMs,
    totalMs,
    compositionBytes: compBytes,
    htmlBytes: Buffer.byteLength(html),
    register: fit.register.name,
    fillPct: Math.round(fit.fill * 100),
    blockSequence: blockSeq,
  };
  writeFileSync(join(OUT, "metrics.json"), JSON.stringify(metrics, null, 2));
  console.log(`metrics: ${JSON.stringify(metrics, null, 2)}`);
  console.log(`\nwrote out/board.html, out/board.png, out/composition.json, out/metrics.json`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
