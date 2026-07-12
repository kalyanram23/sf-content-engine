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
 *   npm run try -- samples/menu.json --parallel=3               # paint up to 3 boards at once (default 2)
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

import { flush } from "braintrust";

import { viewportForAspect } from "../src/config/qa";
import { createNodeEngine } from "../src/node";
import type { CanonicalItem, DebugCapture, Logger, QaScreenReport, ThinPlan } from "../src/index";

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
// bold-poster, bazaar, dhaba). Defaults to bubblegum.
const PRESET = flagValue("preset") ?? "bubblegum";
// Names the run for observability: OpenRouter Broadcast traces carry session_id
// "<restaurant>:<board>:<runId>". Defaults to the menu filename; override with --restaurant=.
const RESTAURANT = flagValue("restaurant") ?? basename(MENU_PATH).replace(/\.json$/i, "");
// `--fresh` wipes real-output/ first (replan + repaint everything); default RESUMES — reuse the
// cached plan and skip boards already written, so a failed/interrupted run continues where it left off.
const FRESH = flags.includes("--fresh");
// Paint up to N boards concurrently (each board is an independent generate() call, mirroring the
// eval harness's --board-parallel). Parallelism multiplies the token BURN RATE and Playwright
// instances, not the total cost. --parallel=1 restores fully-serial behaviour.
const PARALLEL = Math.max(1, Number(flagValue("parallel") ?? "2"));

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
// screen-7 of 10. Each board gets its OWN logger closed over its real position, so the prefix
// rewrite stays correct when boards run concurrently (--parallel) — no shared mutable holder.
const makeLogger = (current?: number, total?: number): Logger => {
  const relabel = (message: string): string =>
    current === undefined || total === undefined
      ? message
      : message
          .replace(/\bboard 1\/1\b/g, `board ${current}/${total}`)
          .replace(/\bboard 1\b(?!\/)/g, `board ${current}`);
  return {
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
};
const logger = makeLogger();

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

/**
 * Run `worker` over `items` with at most `limit` in flight at once, preserving input order in the
 * returned array (results[i] is worker(items[i])). A tiny inline semaphore: `limit` lanes each pull
 * the next job off a shared queue until it drains. `limit <= 1` degrades to serial. (Same helper
 * as the eval harness, scripts/evals/run.ts.)
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const queue = items.map((item, index) => ({ item, index }));
  const results: R[] = [];
  const lane = async (): Promise<void> => {
    for (let job = queue.shift(); job !== undefined; job = queue.shift()) {
      results[job.index] = await worker(job.item, job.index);
    }
  };
  const width = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: width }, lane));
  return results;
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
  const viewport = viewportForAspect(ASPECT);
  // SCREENS is the REQUEST, not the final board count — the plan may cap it (exact mode caps at
  // the category count, D25; elastic mode flexes to fit). The final count is logged post-plan.
  console.log(
    `Menu: ${items.length} items → ${SCREENS} board(s) requested (${SCREENS_MODE}) @ ${ASPECT} (${viewport.width}×${viewport.height})` +
      `${PROMPT ? ` · prompt: "${PROMPT}"` : ""}${DEBUG_ON ? " · debug→debug/" : ""} · parallel=${PARALLEL}\n`,
  );

  if (DEBUG_ON) rmSync(debugDir, { recursive: true, force: true });

  const appUrl = process.env["OPENROUTER_APP_URL"];
  if (BRAINTRUST_ON) {
    logger.info(`Braintrust tracing ON → project "content-engine" (spans flush on exit)`);
  } else {
    logger.info(`Braintrust tracing OFF — set BRAINTRUST_API_KEY (or pass --braintrust) to enable`);
  }

  // One engine per caller: the plan phase uses the plain logger; each board's generate() gets its
  // own engine whose logger knows that board's real position (correct labels under --parallel).
  // Per-board engines mirror the eval harness — independent generate() calls never share state.
  const engineFor = (log: Logger) =>
    createNodeEngine({
      openRouterApiKey: apiKey,
      // Enable client-side Braintrust spans (initLogger + wrapOpenAI) when requested. Off → the engine
      // only emits always-on OpenRouter Broadcast correlation (session_id + trace), no external logger.
      ...(BRAINTRUST_ON ? { braintrust: { projectName: "content-engine" } } : {}),
      // No `plan`: the engine's LLM coverage planner builds it from the menu + screen spec below.
      // Load externalized theme files from ./themes (e.g. themes/bubblegum.theme.json); bundled
      // presets remain available as a fallback for ids not on disk.
      themesDir: "themes",
      logger: log,
      ...(DEBUG_ON ? { debug } : {}),
      appName: process.env["OPENROUTER_APP_NAME"] ?? "content-engine try",
      ...(appUrl !== undefined ? { appUrl } : {}),
      config: {
        // Swap any role — must be an OpenRouter model id on the structured-output allowlist for
        // `plan`/`critique`/`repair` (the critic also needs vision). Override the allowlist if needed.
        models: {
          // The coverage planner: emits a small category-level layout; GLM-5.2 handles this well.
          plan: "anthropic/claude-sonnet-5",
          // Sonnet paints reliably in one attempt with bounded reasoning. GLM-5.2 is ~1/5 the cost
          // when it lands, but on dense boards it stream-aborts and reasoning-runaways past the
          // 32k completion cap (`effort:"low"` doesn't bind it — see models.ts), burning the whole
          // 3-attempt ladder before the fallback rescues it (~20 min/board observed 2026-07-08).
          // Flip back to z-ai/glm-5.2 for cheap runs where wall-clock and consistency don't matter.
          // (The paint FALLBACK stays sonnet-4.6 — models.ts default — so a bad Sonnet-5 day still
          // lands on a different, proven painter.)
          paint: "anthropic/claude-sonnet-5",
          // A capable, fair VISION critic — must support image input + strict structured output;
          // a weak critic over-flags good screens and wastes re-paints, so keep this one solid.
          // 2026-07-09: upgraded from gpt-5.4-mini — even with the full-res screenshot AND the
          // full do/don't brief (D68), mini kept emitting false "truck-art frame missing" majors
          // on boards where the stripe frame is plainly visible, blocking every pass. The judge
          // runs once per iteration on one image; frontier vision here costs ~$0.03/critique.
          critique: "anthropic/claude-sonnet-5",
          repair: "openai/gpt-5.4-nano",
          // The composer fills the strict composition order form for vocabulary themes (D71).
          // Sonnet emits clean, low-latency structured compositions (prototype: 4–9s); it's the
          // models.ts default too, pinned here so a `try` run of a composition theme is explicit.
          compose: "anthropic/claude-sonnet-5",
        },
        // 4 iterations: with vision findings landing from iter 1 (skipVisionWhenBlocking off,
        // below), a board typically needs repair → re-paint → confirm; 3 left no slack for a
        // second visual pass and boards froze flagged on never-repaired vision majors.
        loop: { maxIterations: 4 },
        // "6 means 6" for a dev run (D26): the requested screen count is exact, capped only by the
        // category count (categories are atomic, D25). Override with --screens-mode=elastic.
        planning: { screensMode: SCREENS_MODE },
        qa: {
          // Render + poster geometry, derived from the requested aspect.
          viewport,
          // Run the vision critique on EVERY rendered iteration, even gate-blocked ones (D27's
          // skip saves ~1.1k image tokens/iteration but starves the loop: mechanical majors —
          // e.g. theme-induced token-lint — block vision until the FINAL iteration, so visual
          // majors (missing frame, dead space, invented copy) surface only at freeze, unfixable.
          // 2026-07-08 run: board 1's first critique arrived on iteration 3 of 3. The critique is
          // cheap (gpt-5.4-mini, ~3s, ~$0.002); repair context is worth far more than the skip.
          skipVisionWhenBlocking: false,
          // Coverage mode crams a whole category onto a board, so relax the pre-render capacity
          // caps (which would otherwise force a re-plan); the real rendered-overflow check still
          // guarantees content physically fits, and the planner logs a legibility warning.
          capacities: { matrix: 60, "variant-rows": 48, grid: 48, list: 80 },
        },
      },
    });
  const engine = engineFor(logger);

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

  // 2. Render board-by-board, up to PARALLEL boards in flight (each board is its own generate()
  //    call on its own engine — a single-screen sub-plan), so a finished board is written
  //    immediately and a crash/retry never repaints it. Results come back in board order.
  const totalBoards = plan.screens.length;
  const boardResults = await mapWithConcurrency(
    plan.screens,
    PARALLEL,
    async (screen, index): Promise<{ report: QaScreenReport; reused: boolean }> => {
      const htmlPath = join(outDir, `${screen.id}.html`);
      const reportPath = join(outDir, `${screen.id}.report.json`);
      if (!FRESH && existsSync(htmlPath) && existsSync(reportPath)) {
        const report = JSON.parse(readFileSync(reportPath, "utf8")) as QaScreenReport;
        console.log(`✓ ${screen.id}: already rendered — skipping (delete its files to redo)`);
        return { report, reused: true };
      }
      // The engine sees a 1-screen sub-plan, so its logs say "board 1/1"; a board-scoped logger
      // rewrites that to the real position (safe under concurrency — no shared mutable state).
      const board = await engineFor(makeLogger(index + 1, totalBoards)).generate({
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
      console.log(
        `▸ ${screen.id}: passed=${report.passed} flagged=${report.flagged} iterations=${report.iterations} ` +
          `route=[${report.routeHistory.join(" → ")}]`,
      );
      return { report, reused: false };
    },
  );
  const reports = boardResults.map((r) => r.report);
  const reused = boardResults.filter((r) => r.reused).length;
  const rendered = boardResults.length - reused;

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
