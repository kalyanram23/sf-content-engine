/**
 * Run the engine END-TO-END against a real menu with real services (OpenRouter planner + painter +
 * critic + repair, Playwright rendering, Tailwind compile). The LLM coverage planner auto-
 * distributes ALL menu items across the requested number of screens — no hand-authored plan.
 *
 *   # Credentials live in .env (OPENROUTER_API_KEY, OPENROUTER_APP_NAME/URL) — loaded below.
 *   npx playwright install chromium                              # one-time: the browser binary
 *   npm run try -- samples/menu.json --screens=6                 # EXACTLY 6 boards (D26), 16:9
 *   npm run try -- samples/menu.json --screens=6 --aspect=9:16   # portrait
 *   npm run try -- samples/menu.json --screens-mode=elastic      # let the fit arithmetic flex
 *   npm run try -- samples/menu.json --preset=blockframe         # pick a theme (default bubblegum)
 *   npm run try -- samples/menu.json --screens=6 --prompt "combine biryani and pulav as a price table"
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { flush } from "braintrust";

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
// Braintrust credentials live in a SEPARATE wizard-generated file (.env.braintrust), so the .env
// load above never picks them up. Load it too, so BRAINTRUST_API_KEY is in the environment — both
// for the auto-enable check below and for the Braintrust SDK's own login.
try {
  process.loadEnvFile(".env.braintrust");
} catch {
  /* no .env.braintrust — Braintrust tracing stays off unless the key is already exported */
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
// Screen-count mode (D26). This dev script defaults to EXACT — asking for 6 means 6 (capped only
// by the category count, since categories are atomic, D25). Pass --screens-mode=elastic for the
// public API's default raise-to-fit / lower-if-sparse behaviour.
const SCREENS_MODE: "exact" | "elastic" =
  flagValue("screens-mode") === "elastic" ? "elastic" : "exact";
const ASPECT: "16:9" | "9:16" = flagValue("aspect") === "9:16" ? "9:16" : "16:9";
// Which theme preset to paint against — any id under themes/ (botanical, bubblegum, blockframe,
// bold-poster, bazaar). Defaults to bubblegum.
const PRESET = flagValue("preset") ?? "bubblegum";
// Names the run for observability: OpenRouter Broadcast traces carry session_id
// "<restaurant>:<board>:<runId>". Defaults to the menu filename; override with --restaurant=.
const RESTAURANT = flagValue("restaurant") ?? basename(MENU_PATH).replace(/\.json$/i, "");
// `--fresh` wipes real-output/ first (replan + repaint everything); default RESUMES — reuse the
// cached plan and skip boards already written, so a failed/interrupted run continues where it left off.
const FRESH = flags.includes("--fresh");

// Braintrust tracing (client-side initLogger + wrapOpenAI spans). This is OPT-IN in the engine, so
// it must be enabled here or no traces are ever created. Auto-on when a BRAINTRUST_API_KEY is present
// (loaded from .env.braintrust above); force with --braintrust, disable with --no-braintrust.
const BRAINTRUST_ON =
  !flags.includes("--no-braintrust") &&
  (flags.includes("--braintrust") || Boolean(process.env["BRAINTRUST_API_KEY"]));

// A timestamped console logger so the long, mostly-network run shows live progress. Pass `--verbose`
// (or VERBOSE=1) for debug detail (per-iteration finding kinds, deterministic-repair notes).
const startedAt = Date.now();
const stamp = (): string => `${((Date.now() - startedAt) / 1000).toFixed(1).padStart(5)}s`;

// This script renders board-by-board (each board is its own single-screen generate() call, for
// resumability), so the engine's node logs would always read "board 1/1" — even when painting
// screen-7 of 10. The holder carries the REAL board position (set before each board's generate)
// and the logger rewrites the prefix so progress reads "board 7/10". Boards run sequentially, so
// a mutable holder is safe.
const boardProgress = { current: 1, total: 1 };
const relabel = (message: string): string =>
  message
    .replace(/\bboard 1\/1\b/g, `board ${boardProgress.current}/${boardProgress.total}`)
    .replace(/\bboard 1\b(?!\/)/g, `board ${boardProgress.current}`);

const logger = {
  debug(message: string): void {
    if (VERBOSE) console.log(`  ${stamp()}  · ${relabel(message)}`);
  },
  info(message: string): void {
    console.log(`  ${stamp()}  ${relabel(message)}`);
  },
  warn(message: string): void {
    console.warn(`  ${stamp()}  ⚠ ${relabel(message)}`);
  },
  error(message: string, meta?: Record<string, unknown>): void {
    console.error(`  ${stamp()}  ✖ ${relabel(message)}`, meta ?? "");
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
  // SCREENS is the REQUEST, not the final board count — the plan may cap it (exact mode caps at
  // the category count, D25; elastic mode flexes to fit). The final count is logged post-plan.
  console.log(
    `Menu: ${items.length} items → ${SCREENS} board(s) requested (${SCREENS_MODE}) @ ${ASPECT} (${viewport.width}×${viewport.height})` +
      `${PROMPT ? ` · prompt: "${PROMPT}"` : ""}${DEBUG_ON ? " · debug→debug/" : ""}\n`,
  );

  if (DEBUG_ON) rmSync(debugDir, { recursive: true, force: true });

  const appUrl = process.env["OPENROUTER_APP_URL"];
  if (BRAINTRUST_ON) {
    logger.info(`Braintrust tracing ON → project "content-engine" (spans flush on exit)`);
  } else {
    logger.info(`Braintrust tracing OFF — set BRAINTRUST_API_KEY (or pass --braintrust) to enable`);
  }

  const engine = createNodeEngine({
    openRouterApiKey: apiKey,
    // Enable client-side Braintrust spans (initLogger + wrapOpenAI) when requested. Off → the engine
    // only emits always-on OpenRouter Broadcast correlation (session_id + trace), no external logger.
    ...(BRAINTRUST_ON ? { braintrust: { projectName: "content-engine" } } : {}),
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
      // "6 means 6" for a dev run (D26): the requested screen count is exact, capped only by the
      // category count (categories are atomic, D25). Override with --screens-mode=elastic.
      planning: { screensMode: SCREENS_MODE },
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
    presetId: PRESET,
    density: "balanced" as const,
    restaurant: RESTAURANT,
    ...(PROMPT ? { notes: PROMPT } : {}),
  };
  const baseConstraints = { aspect: ASPECT, locale: "en-US", currency: "USD" } as const;

  // 1. Resolve the plan ONCE (the slow LLM step) and cache it, so a re-run doesn't replan. The
  //    final board count may legitimately differ from the request (exact mode caps at the category
  //    count, elastic mode flexes), so cache validity is judged by the recorded REQUEST — a sidecar
  //    plan.request.json — not by comparing the plan length to SCREENS.
  const planCachePath = join(outDir, "plan.json");
  const planRequestPath = join(outDir, "plan.request.json");
  const planRequest = { screens: SCREENS, screensMode: SCREENS_MODE, aspect: ASPECT };
  let plan: ThinPlan;
  const cached = !FRESH && existsSync(planCachePath) ? readFileSync(planCachePath, "utf8") : null;
  const cachedPlan = cached ? (JSON.parse(cached) as ThinPlan) : null;
  const cachedRequest = existsSync(planRequestPath)
    ? (JSON.parse(readFileSync(planRequestPath, "utf8")) as typeof planRequest)
    : null;
  if (
    cachedPlan &&
    cachedRequest &&
    JSON.stringify(cachedRequest) === JSON.stringify(planRequest)
  ) {
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
    writeFileSync(planRequestPath, JSON.stringify(planRequest, null, 2), "utf8");
  }
  // The FINAL count, post-expansion — this is the number the run actually paints.
  logger.info(
    `plan: ${plan.screens.length} board(s) final (requested ${SCREENS}, mode ${SCREENS_MODE})`,
  );

  // 2. Render board-by-board. Each board is its own generate() call (a single-screen sub-plan), so
  //    a finished board is written immediately and a crash/retry never repaints it.
  const reports: QaScreenReport[] = [];
  let rendered = 0;
  let reused = 0;
  boardProgress.total = plan.screens.length;
  for (const [index, screen] of plan.screens.entries()) {
    // The engine sees a 1-screen sub-plan, so its logs say "board 1/1"; tell the logger the truth.
    boardProgress.current = index + 1;
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

  // Braintrust uploads spans asynchronously; a short-lived script can exit before that finishes.
  // Flush explicitly so traces reliably land (the SDK's beforeExit handler is skipped on process.exit).
  if (BRAINTRUST_ON) await flush();
}

main().catch(async (error: unknown) => {
  console.error("\nGeneration failed:");
  console.error(error);
  // Flush before the hard exit below, or a failed run's spans (the ones you most want) are lost.
  if (BRAINTRUST_ON) await flush();
  process.exit(1);
});
