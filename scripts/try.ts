/**
 * Run the engine END-TO-END against a real menu with real services (OpenRouter painter +
 * critic + repair, Playwright rendering, Tailwind compile) and produce N self-contained
 * 16:9 boards — one per `plan.screens[]` entry.
 *
 *   # Credentials live in .env (OPENROUTER_API_KEY, OPENROUTER_APP_NAME/URL) — loaded below.
 *   npx playwright install chromium                 # one-time: the browser binary
 *   npm run try -- scripts/my-menu.example.json     # default plan = one board per category
 *   npm run try -- samples/menu.json samples/plan.json   # YOU author the per-board allocation
 *
 * The plan is the source of truth for "which category/items go on which board". Supply your
 * own plan.json for full control (see samples/plan.json); otherwise a transparent default is
 * built: each category becomes a board (split into chunks of 6 to fit 16:9).
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { createNodeEngine } from "../src/node";
import type {
  CanonicalItem,
  DebugCapture,
  PlanSection,
  Representation,
  ThinPlan,
} from "../src/index";

// Load credentials from .env (cwd = project root) so real runs need no manual `export`.
// Falls back to the ambient environment (e.g. exported vars / CI) when there is no .env.
try {
  process.loadEnvFile();
} catch {
  /* no .env file — use the existing process environment */
}

// Positional args = file paths; `--flags` are parsed separately (so `--verbose` is not a path).
const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const positionals = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const MENU_PATH = positionals[0] ?? "scripts/my-menu.example.json";
const PLAN_PATH = positionals[1]; // optional: your hand-authored ThinPlan
const VERBOSE = flags.includes("--verbose") || process.env["VERBOSE"] === "1";

// A timestamped console logger so the long, mostly-network run shows live progress. Pass `--verbose`
// (or VERBOSE=1) for debug detail (per-iteration finding kinds, deterministic-repair notes).
const startedAt = Date.now();
const stamp = (): string => `${((Date.now() - startedAt) / 1000).toFixed(1).padStart(5)}s`;
const logger = {
  debug(message: string): void {
    if (VERBOSE) console.log(`  ${stamp()}  · ${message}`);
  },
  info(message: string): void {
    console.log(`  ${stamp()}  ${message}`);
  },
  warn(message: string): void {
    console.warn(`  ${stamp()}  ⚠ ${message}`);
  },
  error(message: string, meta?: Record<string, unknown>): void {
    console.error(`  ${stamp()}  ✖ ${message}`, meta ?? "");
  },
};

// `--boards N` renders only the first N plan screens — cheap iteration while debugging.
const boardsFlag = flags.find((f) => f.startsWith("--boards="));
const BOARD_LIMIT = boardsFlag ? Number(boardsFlag.split("=")[1]) : undefined;

// Debug dump: every scored candidate (each paint/repair attempt) is written under debug/<screen>/
// as raw HTML, packaged HTML, a PNG, and a findings+score JSON — so you can watch each version
// converge. On by default for `try`; pass `--no-debug` to skip.
const DEBUG_ON = !flags.includes("--no-debug");
const debugDir = join(process.cwd(), "debug");
const debug = {
  capture(c: DebugCapture): void {
    const dir = join(debugDir, c.screenId);
    mkdirSync(dir, { recursive: true });
    const base = `attempt-${c.iteration}`;
    writeFileSync(join(dir, `${base}.raw.html`), c.rawHtml, "utf8");
    writeFileSync(join(dir, `${base}.packaged.html`), c.packagedHtml, "utf8");
    writeFileSync(join(dir, `${base}.png`), Buffer.from(c.screenshotBase64, "base64"));
    writeFileSync(
      join(dir, `${base}.findings.json`),
      JSON.stringify(
        {
          screenId: c.screenId,
          iteration: c.iteration,
          route: c.route,
          score: c.score,
          passed: c.passed,
          findings: c.findings,
        },
        null,
        2,
      ),
      "utf8",
    );
  },
};

function representationFor(items: CanonicalItem[]): Representation {
  if (items.some((i) => i.sizes && i.sizes.length > 0)) return "matrix";
  if (items.some((i) => i.variants && i.variants.length > 0)) return "variant-rows";
  return items.length > 4 ? "grid" : "list";
}

/** Default allocation: one board per category, chunked to 6 items so each fits a 16:9 board. */
function defaultPlan(items: CanonicalItem[]): ThinPlan {
  const groups = new Map<string, CanonicalItem[]>();
  for (const item of items) {
    const key = item.category ?? "Menu";
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(item);
  }

  const screens: ThinPlan["screens"] = [];
  const CHUNK = 6;
  for (const [title, groupItems] of groups) {
    const representation = representationFor(groupItems);
    for (let i = 0; i < groupItems.length; i += CHUNK) {
      const slice = groupItems.slice(i, i + CHUNK);
      const section: PlanSection = {
        title:
          i === 0 ? title.toUpperCase() : `${title.toUpperCase()} (${Math.floor(i / CHUNK) + 1})`,
        representation,
        items: slice.map((it) => it.id),
      };
      screens.push({ id: `screen-${screens.length + 1}`, sections: [section] });
    }
  }
  return { screens };
}

async function main(): Promise<void> {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    console.error(
      "Missing OPENROUTER_API_KEY. Put it in .env (OPENROUTER_API_KEY=sk-or-...) or export it.",
    );
    process.exit(1);
  }

  const items: CanonicalItem[] = JSON.parse(readFileSync(MENU_PATH, "utf8"));
  const fullPlan: ThinPlan = PLAN_PATH
    ? JSON.parse(readFileSync(PLAN_PATH, "utf8"))
    : defaultPlan(items);
  // `--boards N` clips to the first N screens for a cheap, fast debugging run.
  const plan: ThinPlan =
    BOARD_LIMIT !== undefined ? { screens: fullPlan.screens.slice(0, BOARD_LIMIT) } : fullPlan;
  const boards = plan.screens.length;
  console.log(
    `Menu: ${items.length} items → ${boards} board(s) [${PLAN_PATH ? "your plan" : "default: one per category"}]` +
      `${BOARD_LIMIT !== undefined ? ` (clipped to ${BOARD_LIMIT})` : ""}${DEBUG_ON ? " · debug→debug/" : ""}\n`,
  );

  if (DEBUG_ON) rmSync(debugDir, { recursive: true, force: true });

  const appUrl = process.env["OPENROUTER_APP_URL"];
  const engine = createNodeEngine({
    openRouterApiKey: apiKey,
    plan,
    // Load externalized theme files from ./themes (e.g. themes/botanical.theme.json); bundled
    // presets remain available as a fallback for ids not on disk.
    themesDir: "themes",
    logger,
    ...(DEBUG_ON ? { debug } : {}),
    appName: process.env["OPENROUTER_APP_NAME"] ?? "content-engine try",
    ...(appUrl !== undefined ? { appUrl } : {}),
    config: {
      // Swap any role — must be an OpenRouter model id on the structured-output allowlist for
      // `critique`/`repair` (the critic also needs vision). Override the allowlist if needed.
      models: {
        // Latest models (checked against the live OpenRouter list). Bump paint to
        // anthropic/claude-opus-4.8 for the strongest layouts at higher cost.
        paint: "anthropic/claude-sonnet-4.6",
        // A capable, fair vision critic — a weak critic over-flags good screens.
        critique: "openai/gpt-5.4",
        repair: "openai/gpt-5.4-mini",
      },
      loop: { maxIterations: 3 },
      // Resolution/DPR each board is rendered + postered at (all 16:9):
      qa: { viewport: { width: 1920, height: 1080, dpr: 1 } },
    },
  });

  console.time("generate");
  const output = await engine.generate({
    items,
    brief: { presetId: "botanical", density: "balanced" },
    constraints: { aspect: "16:9", screens: boards, locale: "en-US", currency: "USD" },
    plan,
  });
  console.timeEnd("generate");

  const outDir = join(process.cwd(), "real-output");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "qa-report.json"), JSON.stringify(output.qaReport, null, 2), "utf8");

  output.screens.forEach((screen, i) => {
    const report = output.qaReport.screens[i]!;
    writeFileSync(join(outDir, `${screen.id}.html`), screen.html, "utf8");
    writeFileSync(
      join(outDir, `${screen.id}.poster.png`),
      Buffer.from(output.posters[i]!.pngBase64, "base64"),
    );
    console.log(
      `▸ ${screen.id}: passed=${report.passed} flagged=${report.flagged} iterations=${report.iterations} ` +
        `route=[${report.routeHistory.join(" → ")}]`,
    );
  });

  console.log(
    `\npassedAll=${output.qaReport.passedAll} — wrote ${output.screens.length} board(s) to real-output/`,
  );
  console.log("Open one:  open real-output/screen-1.html");
}

main().catch((error: unknown) => {
  console.error("\nGeneration failed:");
  console.error(error);
  process.exit(1);
});
