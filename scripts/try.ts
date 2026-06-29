/**
 * Run the engine END-TO-END against a real menu with real services (OpenRouter planner + painter +
 * critic + repair, Playwright rendering, Tailwind compile). The LLM coverage planner auto-
 * distributes ALL menu items across the requested number of screens — no hand-authored plan.
 *
 *   # Credentials live in .env (OPENROUTER_API_KEY, OPENROUTER_APP_NAME/URL) — loaded below.
 *   npx playwright install chromium                              # one-time: the browser binary
 *   npm run try -- samples/menu.json --screens=6                 # 6 boards, all items, 16:9
 *   npm run try -- samples/menu.json --screens=6 --aspect=9:16   # portrait
 *   npm run try -- samples/menu.json --screens=6 --prompt "combine biryani and pulav as a price table"
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { viewportForAspect } from "../src/config/qa";
import { createNodeEngine } from "../src/node";
import type { CanonicalItem, DebugCapture, QaScreenReport, ThinPlan } from "../src/index";

// Load credentials from .env (cwd = project root) so real runs need no manual `export`.
// Falls back to the ambient environment (e.g. exported vars / CI) when there is no .env.
try {
  process.loadEnvFile();
} catch {
  /* no .env file — use the existing process environment */
}

// One positional menu path; `--flags` configure the run. `--prompt` consumes the NEXT token so
// spaces work: `--prompt "combine biryani and pulav as a price table"`.
const rawArgs = process.argv.slice(2);
let PROMPT: string | undefined;
const args: string[] = [];
for (let i = 0; i < rawArgs.length; i += 1) {
  const a = rawArgs[i]!;
  if (a === "--prompt") {
    PROMPT = rawArgs[(i += 1)];
    continue;
  }
  if (a.startsWith("--prompt=")) {
    PROMPT = a.slice("--prompt=".length);
    continue;
  }
  args.push(a);
}
const flags = args.filter((a) => a.startsWith("--"));
const positionals = args.filter((a) => !a.startsWith("--"));
const MENU_PATH = positionals[0] ?? "samples/menu.json";
const VERBOSE = flags.includes("--verbose") || process.env["VERBOSE"] === "1";
const flagValue = (name: string): string | undefined =>
  flags.find((f) => f.startsWith(`--${name}=`))?.split("=")[1];
const SCREENS = Number(flagValue("screens") ?? "6");
const ASPECT: "16:9" | "9:16" = flagValue("aspect") === "9:16" ? "9:16" : "16:9";
// `--fresh` wipes real-output/ first (replan + repaint everything); default RESUMES — reuse the
// cached plan and skip boards already written, so a failed/interrupted run continues where it left off.
const FRESH = flags.includes("--fresh");

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

async function main(): Promise<void> {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (!apiKey) {
    console.error(
      "Missing OPENROUTER_API_KEY. Put it in .env (OPENROUTER_API_KEY=sk-or-...) or export it.",
    );
    process.exit(1);
  }

  const items: CanonicalItem[] = JSON.parse(readFileSync(MENU_PATH, "utf8"));
  const viewport = viewportForAspect(ASPECT);
  console.log(
    `Menu: ${items.length} items → ${SCREENS} board(s) @ ${ASPECT} (${viewport.width}×${viewport.height})` +
      `${PROMPT ? ` · prompt: "${PROMPT}"` : ""}${DEBUG_ON ? " · debug→debug/" : ""}\n`,
  );

  if (DEBUG_ON) rmSync(debugDir, { recursive: true, force: true });

  const appUrl = process.env["OPENROUTER_APP_URL"];
  const engine = createNodeEngine({
    openRouterApiKey: apiKey,
    // No `plan`: the engine's LLM coverage planner builds it from the menu + screen spec below.
    // Load externalized theme files from ./themes (e.g. themes/bubblegum.theme.json); bundled
    // presets remain available as a fallback for ids not on disk.
    themesDir: "themes",
    logger,
    ...(DEBUG_ON ? { debug } : {}),
    appName: process.env["OPENROUTER_APP_NAME"] ?? "content-engine try",
    ...(appUrl !== undefined ? { appUrl } : {}),
    config: {
      // Swap any role — must be an OpenRouter model id on the structured-output allowlist for
      // `plan`/`critique`/`repair` (the critic also needs vision). Override the allowlist if needed.
      models: {
        // The coverage planner: emits a small category-level layout; GLM-5.2 handles this well.
        plan: "z-ai/glm-5.2",
        // GLM-5.2 paints strong HTML at ~1/5 the cost of a frontier model; bump to
        // anthropic/claude-sonnet-4.6 (or x-ai/grok-4.3) if a theme needs richer layout taste.
        paint: "z-ai/glm-5.2",
        // A capable, fair VISION critic — must support image input + strict structured output;
        // a weak critic over-flags good screens and wastes re-paints, so keep this one solid.
        critique: "openai/gpt-5.4-mini",
        repair: "openai/gpt-5.4-nano",
      },
      loop: { maxIterations: 3 },
      qa: {
        // Render + poster geometry, derived from the requested aspect.
        viewport,
        // Coverage mode crams a whole category onto a board, so relax the pre-render capacity
        // caps (which would otherwise force a re-plan); the real rendered-overflow check still
        // guarantees content physically fits, and the planner logs a legibility warning.
        capacities: { matrix: 60, "variant-rows": 48, grid: 48, list: 80 },
      },
    },
  });

  const outDir = join(process.cwd(), "real-output");
  if (FRESH) rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const brief = {
    presetId: "bubblegum",
    density: "balanced" as const,
    ...(PROMPT ? { notes: PROMPT } : {}),
  };
  const baseConstraints = { aspect: ASPECT, locale: "en-US", currency: "USD" } as const;

  // 1. Resolve the plan ONCE (the slow LLM step) and cache it, so a re-run doesn't replan.
  const planCachePath = join(outDir, "plan.json");
  let plan: ThinPlan;
  const cached = !FRESH && existsSync(planCachePath) ? readFileSync(planCachePath, "utf8") : null;
  const cachedPlan = cached ? (JSON.parse(cached) as ThinPlan) : null;
  if (cachedPlan && cachedPlan.screens.length === SCREENS) {
    plan = cachedPlan;
    logger.info(`reusing cached plan (${plan.screens.length} boards) — pass --fresh to replan`);
  } else {
    console.time("plan");
    plan = await engine.plan({
      items,
      brief,
      constraints: { ...baseConstraints, screens: SCREENS },
    });
    console.timeEnd("plan");
    writeFileSync(planCachePath, JSON.stringify(plan, null, 2), "utf8");
  }

  // 2. Render board-by-board. Each board is its own generate() call (a single-screen sub-plan), so
  //    a finished board is written immediately and a crash/retry never repaints it.
  const reports: QaScreenReport[] = [];
  let rendered = 0;
  let reused = 0;
  for (const screen of plan.screens) {
    const htmlPath = join(outDir, `${screen.id}.html`);
    const reportPath = join(outDir, `${screen.id}.report.json`);
    if (!FRESH && existsSync(htmlPath) && existsSync(reportPath)) {
      reports.push(JSON.parse(readFileSync(reportPath, "utf8")) as QaScreenReport);
      console.log(`✓ ${screen.id}: already rendered — skipping (delete its files to redo)`);
      reused += 1;
      continue;
    }
    const board = await engine.generate({
      items,
      brief,
      constraints: { ...baseConstraints, screens: 1 },
      plan: { screens: [screen] },
    });
    const s = board.screens[0]!;
    const report = board.qaReport.screens[0]!;
    writeFileSync(htmlPath, s.html, "utf8");
    writeFileSync(
      join(outDir, `${screen.id}.poster.png`),
      Buffer.from(board.posters[0]!.pngBase64, "base64"),
    );
    writeFileSync(reportPath, JSON.stringify(report, null, 2), "utf8");
    reports.push(report);
    rendered += 1;
    console.log(
      `▸ ${screen.id}: passed=${report.passed} flagged=${report.flagged} iterations=${report.iterations} ` +
        `route=[${report.routeHistory.join(" → ")}]`,
    );
  }

  // 3. Assemble the combined QA report across all boards (rendered + reused).
  writeFileSync(
    join(outDir, "qa-report.json"),
    JSON.stringify(
      {
        screens: reports,
        passedAll: reports.every((r) => r.passed),
        generatedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(
    `\npassedAll=${reports.every((r) => r.passed)} — ${rendered} rendered, ${reused} reused → real-output/ (${reports.length} board(s))`,
  );
  console.log(`Open one:  open real-output/${plan.screens[0]?.id ?? "screen-1"}.html`);
}

main().catch((error: unknown) => {
  console.error("\nGeneration failed:");
  console.error(error);
  process.exit(1);
});
