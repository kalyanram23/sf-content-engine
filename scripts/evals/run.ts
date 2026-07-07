/**
 * Eval runner — drives the REAL engine (OpenRouter + Playwright) over the frozen scenario suite
 * in cases.ts, grades every shipped board with the code graders, asks an independent vision
 * model for a second opinion on each poster, and writes a scorecard.
 *
 *   npm run eval                         # full suite → eval-output/
 *   npm run eval -- --case=tiny-menu,sparse-board
 *   npm run eval -- --fresh              # wipe eval-output/ and redo everything
 *   npm run eval -- --no-judge           # skip the independent vision judge
 *   npm run eval -- --out=eval-output-2  # write to a different folder (e.g. a repeat run)
 *
 * Requires OPENROUTER_API_KEY in .env and `npx playwright install chromium` (one-time).
 * Runs RESUME by default: finished boards are skipped, so a crashed run continues cheaply.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { flush } from "braintrust";

import { viewportForAspect } from "../../src/config/qa";
import { createNodeEngine } from "../../src/node";
import type { QaScreenReport, ThinPlan } from "../../src/index";
import { loadEngineConfig } from "../../src/index";
import { evalCases, type EvalCase } from "./cases";
import type { GraderResult } from "./graders";
import {
  balanceSpread,
  gradeBindingsInHtml,
  gradeCategoryAtomic,
  gradeCategoryImages,
  gradePlanCoverage,
  gradePosterGeometry,
  gradeQaPassed,
  gradeReportConsistency,
  gradeScreensExact,
  gradeSelfContained,
  summarizeFindings,
} from "./graders";

try {
  process.loadEnvFile();
} catch {
  /* no .env — use the ambient environment */
}
// Braintrust credentials live in a SEPARATE wizard-generated file (.env.braintrust); the .env load
// above never picks them up. Load it too so BRAINTRUST_API_KEY is in the environment — both for the
// auto-enable check below and for the Braintrust SDK's own login (mirrors scripts/try.ts).
try {
  process.loadEnvFile(".env.braintrust");
} catch {
  /* no .env.braintrust — Braintrust tracing stays off unless the key is already exported */
}

/* ------------------------------------------------------------------ flags */

const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
const flagValue = (name: string): string | undefined =>
  flags.find((f) => f.startsWith(`--${name}=`))?.split("=")[1];
const intFlag = (name: string, dflt: number): number => {
  const raw = flagValue(name);
  const n = raw === undefined ? NaN : Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 1 ? n : dflt;
};
const FRESH = flags.includes("--fresh");
const VERBOSE = flags.includes("--verbose");
const JUDGE_ON = !flags.includes("--no-judge");
// Fast iteration tier: only the cases marked `smoke: true` in cases.ts (~4 boards, minutes).
// Applied BEFORE --case, so the two compose: --smoke --case=portrait still narrows to portrait.
const SMOKE = flags.includes("--smoke");
const ONLY = flagValue("case")?.split(",");
const OUT_DIR = join(process.cwd(), flagValue("out") ?? "eval-output");
// Concurrency: run up to PARALLEL cases at once, and inside each case up to BOARD_PARALLEL
// independent generate() calls. --parallel=1 restores the original fully-serial behavior.
const PARALLEL = intFlag("parallel", 3);
const BOARD_PARALLEL = intFlag("board-parallel", 2);
// Only prefix log lines with the case id when >1 case can be in flight (else output is unchanged).
const LOG_PREFIXED = PARALLEL > 1;

const USAGE = `Eval runner — drives the real engine over the frozen scenario suite (cases.ts).

  npm run eval [-- <flags>]

Flags:
  --smoke                        fast iteration tier: only the smoke cases (~4 boards, minutes)
  --case=<id,id>                 run only these scenario ids (default: all; composes with --smoke)
  --parallel=N                   run up to N cases concurrently (default 3; 1 = serial)
  --board-parallel=M             run up to M boards of a case concurrently (default 2)
  --fresh                        wipe --out and regenerate everything (default: resume)
  --no-judge                     skip the independent vision judge
  --out=<dir>                    output folder (default: eval-output)
  --braintrust / --no-braintrust force Braintrust tracing on/off (auto-on when a key is present)
  --verbose                      per-call debug logging
  -h, --help                     print this help and exit

Parallelism multiplies the token BURN RATE (same total cost, more tokens per minute) and spins up
one transient Chromium per in-flight render. The defaults (3 × 2) stay well under OpenRouter's rate
limits; raise them only if you know you have the headroom.`;
if (flags.includes("--help") || process.argv.slice(2).includes("-h")) {
  console.log(USAGE);
  process.exit(0);
}
// Braintrust tracing (client-side initLogger + wrapOpenAI spans on the engine's OpenRouter calls).
// OPT-IN in the engine, so it must be enabled here or no traces are created. Auto-on when a
// BRAINTRUST_API_KEY is present (loaded from .env.braintrust above); force with --braintrust,
// disable with --no-braintrust. The harness's own judge fetch is deliberately NOT traced.
const BRAINTRUST_ON =
  !flags.includes("--no-braintrust") &&
  (flags.includes("--braintrust") || Boolean(process.env["BRAINTRUST_API_KEY"]));

/* ------------------------------------------------------------------ models under test */

const MODELS = {
  plan: "z-ai/glm-5.2",
  paint: "z-ai/glm-5.2",
  critique: "openai/gpt-5.4-mini",
  repair: "openai/gpt-5.4-nano",
} as const;
/** Independent second opinion on finished posters — deliberately a DIFFERENT model family. */
const JUDGE_MODEL = "anthropic/claude-opus-4.8";

const engineConfigFor = (aspect: "16:9" | "9:16"): Record<string, unknown> => ({
  models: { ...MODELS },
  loop: { maxIterations: 3 },
  // "6 means 6" (D26) so the screens-exact grader has a defined expectation.
  planning: { screensMode: "exact" },
  // Same relaxed pre-render caps the try script uses: coverage mode puts whole categories on a
  // board; the rendered overflow check still guarantees content physically fits.
  qa: {
    viewport: viewportForAspect(aspect),
    capacities: { matrix: 60, "variant-rows": 48, grid: 48, list: 80 },
  },
});

/* ------------------------------------------------------------------ token/cost capture */

interface UsageBucket {
  calls: number;
  prompt: number;
  completion: number;
  total: number;
  reasoning: number;
  fallbackCalls: number;
}
type UsageByRole = Record<string, UsageBucket>;

const newBucket = (): UsageBucket => ({
  calls: 0,
  prompt: 0,
  completion: 0,
  total: 0,
  reasoning: 0,
  fallbackCalls: 0,
});
const emptyUsage = (): UsageByRole => ({});
const addUsage = (into: UsageByRole, from: UsageByRole): void => {
  for (const [role, u] of Object.entries(from)) {
    const bucket = (into[role] ??= newBucket());
    bucket.calls += u.calls;
    bucket.prompt += u.prompt;
    bucket.completion += u.completion;
    bucket.total += u.total;
    bucket.reasoning += u.reasoning ?? 0;
    bucket.fallbackCalls += u.fallbackCalls ?? 0;
  }
};

/** Which model served each role (for pricing) — filled from usage events. Shared across cases is
 *  safe: every board uses the same model per role, so concurrent identical `.set`s never conflict. */
const modelByRole = new Map<string, string>();

/**
 * Structured per-call usage via the engine's UsageSink port (D28) — no log parsing. Constructed
 * PER generate() call, bound to that call's own bucket (`into`), so concurrent plan/board runs each
 * accumulate into their own bucket instead of a shared mutable scope (concurrency-safe attribution).
 */
const makeUsageSink = (into: UsageByRole) => ({
  record(event: {
    role: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    reasoningTokens?: number;
    fallback?: boolean;
  }): void {
    modelByRole.set(event.role, event.model);
    const bucket = (into[event.role] ??= newBucket());
    bucket.calls += 1;
    bucket.prompt += event.promptTokens;
    bucket.completion += event.completionTokens;
    bucket.total += event.totalTokens;
    bucket.reasoning += event.reasoningTokens ?? 0;
    if (event.fallback === true) bucket.fallbackCalls += 1;
  },
});

/** $/token by model id, from the public OpenRouter model list. Undefined → tokens-only report. */
async function fetchPricing(): Promise<Map<string, { prompt: number; completion: number }>> {
  const pricing = new Map<string, { prompt: number; completion: number }>();
  try {
    const res = await fetch("https://openrouter.ai/api/v1/models");
    if (!res.ok) return pricing;
    const body = (await res.json()) as { data?: Array<Record<string, unknown>> };
    for (const model of body.data ?? []) {
      const id = model["id"];
      const p = model["pricing"] as Record<string, unknown> | undefined;
      if (typeof id !== "string" || p === undefined) continue;
      pricing.set(id, {
        prompt: Number(p["prompt"] ?? 0),
        completion: Number(p["completion"] ?? 0),
      });
    }
  } catch {
    /* offline or API change — cost column simply stays empty */
  }
  return pricing;
}

function estimateCost(
  usage: UsageByRole,
  pricing: Map<string, { prompt: number; completion: number }>,
): number | undefined {
  let cost = 0;
  let priced = false;
  for (const [role, bucket] of Object.entries(usage)) {
    const model = modelByRole.get(role);
    const rate = model !== undefined ? pricing.get(model) : undefined;
    if (rate === undefined) continue;
    cost += bucket.prompt * rate.prompt + bucket.completion * rate.completion;
    priced = true;
  }
  return priced ? cost : undefined;
}

/* ------------------------------------------------------------------ logger */

const startedAt = Date.now();
const stamp = (): string => `${((Date.now() - startedAt) / 1000).toFixed(0).padStart(5)}s`;
/**
 * A logger whose every line carries `prefix` (the case id under concurrency, "" when serial → the
 * exact old output). Built per case so concurrent cases' log lines stay tellable apart.
 */
const makeLogger = (prefix: string) => ({
  debug(message: string): void {
    if (VERBOSE) console.log(`${prefix}  ${stamp()}  · ${message}`);
  },
  info(message: string): void {
    console.log(`${prefix}  ${stamp()}  ${message}`);
  },
  warn(message: string): void {
    console.warn(`${prefix}  ${stamp()}  ⚠ ${message}`);
  },
  error(message: string, meta?: Record<string, unknown>): void {
    console.error(`${prefix}  ${stamp()}  ✖ ${message}`, meta ?? "");
  },
});

/* ------------------------------------------------------------------ independent judge */

interface JudgeVerdict {
  approved: boolean;
  reason: string;
}

const JUDGE_PROMPT =
  "You are a picky restaurant owner reviewing ONE digital menu board destined for the TV in " +
  "your dining room. Judge only what you can see in the image. Reply with STRICT JSON, nothing " +
  'else: {"verdict": "ship" | "reject", "reason": "<one short sentence>"}. ' +
  '"ship" means you would put this on your screen today. "reject" means a paying customer ' +
  "would notice something off: unreadable or overlapping text, content cut off at the edges, " +
  "large awkward empty areas, broken or badly cropped images, or an overall amateur look.";

async function judgePoster(
  apiKey: string,
  pngBase64: string,
  into: UsageByRole,
  log: { warn(message: string): void },
): Promise<JudgeVerdict | undefined> {
  try {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: JUDGE_MODEL,
        max_tokens: 300,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: JUDGE_PROMPT },
              { type: "image_url", image_url: { url: `data:image/png;base64,${pngBase64}` } },
            ],
          },
        ],
      }),
    });
    if (!res.ok) {
      log.warn(`judge call failed: HTTP ${res.status}`);
      return undefined;
    }
    const body = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
    };
    const usage = body.usage;
    if (usage !== undefined) {
      modelByRole.set("judge", JUDGE_MODEL);
      const bucket = (into["judge"] ??= newBucket());
      bucket.calls += 1;
      bucket.prompt += usage.prompt_tokens ?? 0;
      bucket.completion += usage.completion_tokens ?? 0;
      bucket.total += usage.total_tokens ?? 0;
    }
    const text = body.choices?.[0]?.message?.content ?? "";
    const json = /\{[\s\S]*\}/.exec(text)?.[0];
    if (json === undefined) return undefined;
    const parsed = JSON.parse(json) as { verdict?: unknown; reason?: unknown };
    if (parsed.verdict !== "ship" && parsed.verdict !== "reject") return undefined;
    return { approved: parsed.verdict === "ship", reason: String(parsed.reason ?? "") };
  } catch (error) {
    log.warn(`judge call errored: ${String(error)}`);
    return undefined;
  }
}

/* ------------------------------------------------------------------ result shapes */

interface BoardResult {
  screenId: string;
  reused: boolean;
  error?: string;
  passed: boolean;
  flagged: boolean;
  iterations: number;
  routeHistory: string[];
  rubricScore: number;
  penalty: number;
  findingsSummary: string;
  graders: GraderResult[];
  judge?: JudgeVerdict;
  ms: number;
  usage: UsageByRole;
}

interface CaseResult {
  id: string;
  what: string;
  presetId: string;
  aspect: string;
  screensRequested: number;
  menuItems: number;
  error?: string;
  planGraders: GraderResult[];
  itemsPerBoard: number[];
  planMs: number;
  planReused: boolean;
  boards: BoardResult[];
  usage: UsageByRole;
  costUsd?: number;
}

/* ------------------------------------------------------------------ concurrency limiter */

/**
 * Run `worker` over `items` with at most `limit` in flight at once, preserving input order in the
 * returned array (results[i] is worker(items[i])). A tiny inline semaphore: `limit` lanes each pull
 * the next job off a shared queue until it drains. `limit <= 1` degrades to serial.
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

/* ------------------------------------------------------------------ main */

async function main(): Promise<void> {
  const apiKey = process.env["OPENROUTER_API_KEY"];
  if (apiKey === undefined || apiKey === "") {
    console.error("Missing OPENROUTER_API_KEY (put it in .env).");
    process.exit(1);
  }

  // --smoke narrows first, then --case narrows within that (the two compose).
  const tier = SMOKE ? evalCases.filter((c) => c.smoke === true) : evalCases;
  const cases = ONLY === undefined ? tier : tier.filter((c) => ONLY.includes(c.id));
  if (cases.length === 0) {
    console.error(
      `No cases match${SMOKE ? " --smoke" : ""}${ONLY !== undefined ? ` --case=${ONLY.join(",")}` : ""}`,
    );
    process.exit(1);
  }

  // --fresh forces a redo. Scope it to what was ASKED for: with --case (ONLY) set, wipe only the
  // selected cases' subdirectories so every other case's cached output survives; without --case,
  // wipe the whole out dir for a clean-slate suite run.
  if (FRESH) {
    if (ONLY === undefined) {
      rmSync(OUT_DIR, { recursive: true, force: true });
    } else {
      for (const c of cases) rmSync(join(OUT_DIR, c.id), { recursive: true, force: true });
    }
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const pricing = await fetchPricing();
  // The rubric + blocking policy the engine itself uses, for the report-consistency grader.
  const fullConfig = loadEngineConfig(engineConfigFor("16:9"));

  console.log(
    `Eval suite: ${SMOKE ? `smoke tier: ${cases.length} case(s)` : `${cases.length} case(s)`} → ${OUT_DIR}\n` +
      `  models: plan/paint=${MODELS.plan} critique=${MODELS.critique} repair=${MODELS.repair}` +
      `${JUDGE_ON ? ` judge=${JUDGE_MODEL}` : " (judge off)"}\n` +
      `  concurrency: up to ${PARALLEL} case(s) × ${BOARD_PARALLEL} board(s) in flight` +
      `${BRAINTRUST_ON ? `\n  Braintrust tracing ON → project "content-engine" (spans flush on exit)` : ""}\n`,
  );

  // Each case owns a fixed slot so the scorecard stays in case order regardless of which case
  // finishes first; writeReports renders the slots filled so far. Only one place ever writes the
  // report files, and writeFileSync is synchronous, so concurrent completions can't interleave a
  // half-written file.
  const results: (CaseResult | undefined)[] = [];
  const writeReports = (): void => {
    const done = results.filter((r): r is CaseResult => r !== undefined);
    writeFileSync(join(OUT_DIR, "summary.json"), JSON.stringify(done, null, 2), "utf8");
    writeFileSync(join(OUT_DIR, "scorecard.md"), renderScorecard(done), "utf8");
  };

  const runCase = async (evalCase: EvalCase, caseIndex: number): Promise<void> => {
    // Under case-level concurrency, tag every line with the case id; serial → no prefix (unchanged).
    const prefix = LOG_PREFIXED ? `[${evalCase.id}] ` : "";
    const log = makeLogger(prefix);
    const clog = (message: string): void => console.log(prefix + message);

    console.log(`\n${prefix}━━ ${evalCase.id} — ${evalCase.what}`);
    const caseDir = join(OUT_DIR, evalCase.id);
    mkdirSync(caseDir, { recursive: true });
    const menu = evalCase.menu();
    const viewport = viewportForAspect(evalCase.aspect);

    const result: CaseResult = {
      id: evalCase.id,
      what: evalCase.what,
      presetId: evalCase.presetId,
      aspect: evalCase.aspect,
      screensRequested: evalCase.screens,
      menuItems: menu.length,
      planGraders: [],
      itemsPerBoard: [],
      planMs: 0,
      planReused: false,
      boards: [],
      usage: emptyUsage(),
    };
    results[caseIndex] = result;

    // A fresh engine PER generate() call, each wired to its own UsageSink→bucket (below), so a
    // board's tokens land in that board's bucket even when boards run concurrently. Client-side
    // Braintrust spans (initLogger + wrapOpenAI) when enabled; off → only the always-on OpenRouter
    // Broadcast correlation. Trace/session metadata is derived per call from its own arguments, so
    // overlapping generate() calls never cross-attribute.
    const makeEngine = (usage: ReturnType<typeof makeUsageSink>) =>
      createNodeEngine({
        openRouterApiKey: apiKey,
        ...(BRAINTRUST_ON ? { braintrust: { projectName: "content-engine" } } : {}),
        themesDir: "themes",
        logger: log,
        usage,
        appName: "content-engine evals",
        config: engineConfigFor(evalCase.aspect),
      });

    const brief = {
      presetId: evalCase.presetId,
      density: "balanced" as const,
      restaurant: evalCase.restaurant,
    };
    // Real brand for the masthead: the case's restaurant name shows on every board's masthead
    // band, so the painter no longer invents a fake establishment name to fill that slot.
    const brand = { name: evalCase.restaurant };
    const constraints = {
      aspect: evalCase.aspect,
      locale: "en-US",
      currency: "USD",
    } as const;

    // Plan once per case (cached on disk so a resumed run never replans). Plan tokens accumulate
    // into the case's own bucket (result.usage), exactly as before.
    const planPath = join(caseDir, "plan.json");
    let plan: ThinPlan;
    try {
      if (!FRESH && existsSync(planPath)) {
        plan = JSON.parse(readFileSync(planPath, "utf8")) as ThinPlan;
        result.planReused = true;
        log.info(`plan: reusing cached plan (${plan.screens.length} boards)`);
      } else {
        const t0 = Date.now();
        plan = await makeEngine(makeUsageSink(result.usage)).plan({
          items: menu,
          brief,
          constraints: { ...constraints, screens: evalCase.screens },
        });
        result.planMs = Date.now() - t0;
        writeFileSync(planPath, JSON.stringify(plan, null, 2), "utf8");
        log.info(`plan: ${plan.screens.length} board(s) in ${(result.planMs / 1000).toFixed(1)}s`);
      }
    } catch (error) {
      result.error = `plan failed: ${String(error)}`;
      log.error(result.error);
      writeReports();
      return;
    }

    result.planGraders = [
      gradePlanCoverage(plan, menu),
      gradeCategoryAtomic(plan, menu),
      gradeScreensExact(plan, menu, evalCase.screens),
    ];
    result.itemsPerBoard = balanceSpread(plan).perBoard;
    for (const grader of result.planGraders) {
      clog(`  ${grader.pass ? "✓" : "✗"} ${grader.id}: ${grader.detail}`);
    }

    // Paint the boards, up to BOARD_PARALLEL at once. Each board is an independent generate() call
    // with its own engine + sink + bucket; a finished board's <screen>.board.json lets a crash
    // resume without re-running it (unless --fresh). Results come back in board order.
    const totalBoards = plan.screens.length;
    const boardResults = await mapWithConcurrency(
      plan.screens,
      BOARD_PARALLEL,
      async (screen, index): Promise<BoardResult> => {
        const boardJsonPath = join(caseDir, `${screen.id}.board.json`);
        if (!FRESH && existsSync(boardJsonPath)) {
          const reloaded = JSON.parse(readFileSync(boardJsonPath, "utf8")) as BoardResult;
          reloaded.reused = true;
          clog(`  ✓ ${screen.id}: already rendered — reusing its result`);
          return reloaded;
        }

        const boardUsage = emptyUsage();
        const t0 = Date.now();
        let board: BoardResult;
        try {
          const output = await makeEngine(makeUsageSink(boardUsage)).generate({
            items: menu,
            brief,
            brand,
            constraints: { ...constraints, screens: 1 },
            plan: { screens: [screen] },
          });
          const shipped = output.screens[0];
          const poster = output.posters[0];
          const report: QaScreenReport | undefined = output.qaReport.screens[0];
          if (report === undefined) {
            throw new Error("engine returned no report");
          }
          if (shipped === undefined) {
            // Bulkhead case (D28): the board failed terminally; the engine contained it and
            // reported the error instead of throwing. Record it as a failed board.
            throw new Error(
              `board failed terminally (${report.error?.code ?? "unknown"}): ${report.error?.message ?? "no screen shipped"}`,
            );
          }
          const consistency = gradeReportConsistency(
            report,
            fullConfig.rubric,
            fullConfig.qa.blockingSeverity,
          );
          const judgeVerdict =
            JUDGE_ON && poster !== undefined
              ? await judgePoster(apiKey, poster.pngBase64, boardUsage, log)
              : undefined;
          board = {
            screenId: screen.id,
            reused: false,
            passed: report.passed,
            flagged: report.flagged,
            iterations: report.iterations,
            routeHistory: [...report.routeHistory],
            rubricScore: consistency.rubricScore,
            penalty: consistency.penalty,
            findingsSummary: summarizeFindings(report),
            graders: [
              gradeQaPassed(report),
              gradeBindingsInHtml(
                shipped.html,
                screen.sections.flatMap((s) => s.items),
              ),
              gradeSelfContained(shipped.html),
              gradePosterGeometry(poster, viewport),
              gradeCategoryImages(shipped.html, screen, menu),
              consistency.grader,
            ],
            ...(judgeVerdict !== undefined ? { judge: judgeVerdict } : {}),
            ms: Date.now() - t0,
            usage: boardUsage,
          };
          writeFileSync(join(caseDir, `${screen.id}.html`), shipped.html, "utf8");
          if (poster !== undefined) {
            writeFileSync(
              join(caseDir, `${screen.id}.poster.png`),
              Buffer.from(poster.pngBase64, "base64"),
            );
          }
          writeFileSync(join(caseDir, `${screen.id}.report.json`), JSON.stringify(report, null, 2));
        } catch (error) {
          board = {
            screenId: screen.id,
            reused: false,
            error: String(error),
            passed: false,
            flagged: false,
            iterations: 0,
            routeHistory: [],
            rubricScore: 0,
            penalty: 0,
            findingsSummary: "generation crashed",
            graders: [
              { id: "qa-passed", pass: false, detail: `generation crashed: ${String(error)}` },
            ],
            ms: Date.now() - t0,
            usage: boardUsage,
          };
        }
        writeFileSync(boardJsonPath, JSON.stringify(board, null, 2), "utf8");
        const failing = board.graders.filter((g) => !g.pass);
        clog(
          `  ${failing.length === 0 ? "✓" : "✗"} board ${index + 1}/${totalBoards} ${screen.id}: ` +
            `qa=${board.passed ? "pass" : "FAIL"}${board.flagged ? " (flagged)" : ""} ` +
            `iterations=${board.iterations} rubric=${board.rubricScore.toFixed(2)} ` +
            `judge=${board.judge === undefined ? "n/a" : board.judge.approved ? "ship" : "REJECT"} ` +
            `${(board.ms / 1000).toFixed(0)}s`,
        );
        for (const grader of failing) clog(`      ✗ ${grader.id}: ${grader.detail}`);
        if (board.judge !== undefined && !board.judge.approved) {
          clog(`      judge: ${board.judge.reason}`);
        }
        return board;
      },
    );

    result.boards = boardResults;
    // Fold each freshly-generated board's tokens into the case bucket. Reused boards are skipped
    // (their tokens were already spent on a prior run) — matching the serial runner's accounting.
    for (const b of boardResults) if (!b.reused) addUsage(result.usage, b.usage);

    const costUsd = estimateCost(result.usage, pricing);
    if (costUsd !== undefined) result.costUsd = costUsd;
    writeReports();
  };

  await mapWithConcurrency(cases, PARALLEL, runCase);

  writeReports();
  console.log(`\nDone in ${stamp().trim()} → ${join(OUT_DIR, "scorecard.md")}`);

  // Braintrust uploads spans asynchronously; a short-lived script can exit before that finishes.
  // Flush explicitly so traces reliably land (the SDK's beforeExit handler is skipped on process.exit).
  if (BRAINTRUST_ON) await flush();
}

/* ------------------------------------------------------------------ scorecard */

function renderScorecard(results: CaseResult[]): string {
  const allBoards = results.flatMap((r) => r.boards);
  const done = allBoards.length;
  const qaPassed = allBoards.filter((b) => b.passed).length;
  const flagged = allBoards.filter((b) => b.flagged).length;
  const judged = allBoards.filter((b) => b.judge !== undefined);
  const judgeShip = judged.filter((b) => b.judge?.approved === true).length;
  const agree = judged.filter((b) => b.judge !== undefined && b.judge.approved === b.passed).length;
  const crashed = allBoards.filter((b) => b.error !== undefined).length;
  const hardGraders = ["plan-coverage", "category-atomic", "screens-exact"];
  const totalCost = results.reduce((sum, r) => sum + (r.costUsd ?? 0), 0);
  const totalMinutes = results.reduce(
    (sum, r) => sum + r.planMs + r.boards.reduce((s, b) => s + (b.reused ? 0 : b.ms), 0),
    0,
  );

  const lines: string[] = [];
  lines.push(`# Content-engine eval scorecard`);
  lines.push("");
  lines.push(`_Run: ${new Date().toISOString()} · models: plan/paint=${MODELS.plan}, `);
  lines.push(`critique=${MODELS.critique}, repair=${MODELS.repair}, judge=${JUDGE_MODEL}_`);
  lines.push("");
  lines.push(`## Headline`);
  lines.push("");
  lines.push(`| Metric | Result |`);
  lines.push(`| --- | --- |`);
  lines.push(`| Boards generated | ${done} across ${results.length} scenario(s) |`);
  lines.push(`| Passed the engine's own QA | ${qaPassed}/${done} |`);
  lines.push(`| Shipped flagged (best effort after budget) | ${flagged}/${done} |`);
  if (judged.length > 0) {
    lines.push(`| Independent judge would ship | ${judgeShip}/${judged.length} |`);
    lines.push(`| Judge agrees with engine QA | ${agree}/${judged.length} |`);
  }
  if (crashed > 0) lines.push(`| Crashed boards | ${crashed} |`);
  lines.push(`| Est. LLM spend | ${totalCost > 0 ? `$${totalCost.toFixed(2)}` : "n/a"} |`);
  lines.push(`| Active generation time | ${(totalMinutes / 60000).toFixed(1)} min |`);
  lines.push("");

  lines.push(`## Bookkeeping guarantees (must always pass)`);
  lines.push("");
  lines.push(`| Check | Scenarios passing |`);
  lines.push(`| --- | --- |`);
  for (const graderId of hardGraders) {
    const graded = results.filter((r) => r.planGraders.some((g) => g.id === graderId));
    const passing = graded.filter(
      (r) => r.planGraders.find((g) => g.id === graderId)?.pass === true,
    );
    lines.push(`| ${graderId} | ${passing.length}/${graded.length} |`);
  }
  lines.push("");

  lines.push(`## Per scenario`);
  lines.push("");
  lines.push(`| Scenario | Boards | QA pass | Judge ship | Avg tries | Items/board | Est. cost |`);
  lines.push(`| --- | --- | --- | --- | --- | --- | --- |`);
  for (const r of results) {
    const boards = r.boards;
    const pass = boards.filter((b) => b.passed).length;
    const judgedBoards = boards.filter((b) => b.judge !== undefined);
    const ship = judgedBoards.filter((b) => b.judge?.approved === true).length;
    const tries =
      boards.length > 0
        ? (boards.reduce((s, b) => s + b.iterations, 0) / boards.length).toFixed(1)
        : "—";
    lines.push(
      `| ${r.id} | ${boards.length} | ${pass}/${boards.length} | ` +
        `${judgedBoards.length > 0 ? `${ship}/${judgedBoards.length}` : "—"} | ${tries} | ` +
        `${r.itemsPerBoard.join(" / ")} | ${r.costUsd !== undefined ? `$${r.costUsd.toFixed(2)}` : "—"} |`,
    );
  }
  lines.push("");

  lines.push(`## What went wrong (all findings on shipped boards)`);
  lines.push("");
  const findingCounts = new Map<string, number>();
  for (const b of allBoards) {
    if (b.findingsSummary === "no findings" || b.error !== undefined) continue;
    for (const part of b.findingsSummary.split(", ")) {
      const m = /^(.+?)(?:×(\d+))?$/.exec(part);
      if (m?.[1] !== undefined) {
        findingCounts.set(m[1], (findingCounts.get(m[1]) ?? 0) + Number(m[2] ?? 1));
      }
    }
  }
  if (findingCounts.size === 0) {
    lines.push(`No findings on any shipped board.`);
  } else {
    lines.push(`| Finding | Count |`);
    lines.push(`| --- | --- |`);
    for (const [kind, count] of [...findingCounts.entries()].sort((a, b) => b[1] - a[1])) {
      lines.push(`| ${kind} | ${count} |`);
    }
  }
  lines.push("");

  lines.push(`## Board-by-board`);
  lines.push("");
  for (const r of results) {
    lines.push(`### ${r.id} — ${r.what}`);
    lines.push("");
    if (r.error !== undefined) {
      lines.push(`**Case failed:** ${r.error}`);
      lines.push("");
      continue;
    }
    for (const g of r.planGraders.filter((g) => !g.pass)) {
      lines.push(`- ✗ plan grader **${g.id}**: ${g.detail}`);
    }
    for (const b of r.boards) {
      const judgeText =
        b.judge === undefined
          ? ""
          : b.judge.approved
            ? ` · judge: ship`
            : ` · judge: REJECT — ${b.judge.reason}`;
      lines.push(
        `- **${b.screenId}** — qa=${b.passed ? "pass" : "fail"}${b.flagged ? " (flagged)" : ""}, ` +
          `${b.iterations} tries, rubric ${b.rubricScore.toFixed(2)}, ` +
          `findings: ${b.findingsSummary}${judgeText}`,
      );
      for (const g of b.graders.filter((g) => !g.pass && g.id !== "qa-passed")) {
        lines.push(`  - ✗ ${g.id}: ${g.detail}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

main().catch(async (error: unknown) => {
  console.error("\nEval run failed:");
  console.error(error);
  // Flush before the hard exit below, or a failed run's spans (the ones you most want) are lost.
  if (BRAINTRUST_ON) await flush();
  process.exit(1);
});
