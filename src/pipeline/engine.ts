import { type EngineConfig, loadEngineConfig } from "../config/index";
import {
  ContentEngineError,
  type ContentEngineErrorCode,
  UnsupportedConstraintError,
  ValidationError,
} from "../domain/errors";
import { parseOrThrow } from "../domain/parse";
import { generateInputSchema, generateOutputSchema, thinPlanSchema } from "../domain/schemas";
import type {
  CanonicalItem,
  GenerateInput,
  GenerateOutput,
  MenuLintFinding,
  Poster,
  QaScreenReport,
  SelfContainedScreen,
  ThinPlan,
} from "../domain/types";
import { applyMenuRenderPolicy, runMenuLint } from "../planning/menu-lint";
import type { RequestCorrelation } from "../ports/correlation";
import type { EnginePorts } from "../ports/index";
import { compileGraph, recursionLimitFor } from "./graph";
import type { FrozenScreen, NodeContext } from "./state";

/**
 * Per-board bulkhead (D28): the error codes whose failure is contained to ONE board — its pipeline
 * couldn't produce an artifact after all adapter-level retries/fallbacks. When one of these trips,
 * the other boards still complete and ship, and the failed board gets an error report (no
 * screen/poster). Everything else — input validation, THEME_NOT_FOUND (same preset for the whole
 * run), CONFIG, MATRIX_COVERAGE, and the INTERNAL router-termination safety net — is a run-level or
 * engine-invariant failure that still aborts the whole generate(), exactly as before.
 */
const BOARD_CONTAINED_CODES: ReadonlySet<ContentEngineErrorCode> = new Set([
  "PAINT",
  "PACKAGING",
  "RENDER",
  "LLM_CONTRACT",
  "QA_BUDGET",
]);

function isBoardContainedError(error: unknown): error is ContentEngineError {
  return error instanceof ContentEngineError && BOARD_CONTAINED_CODES.has(error.code);
}

/** The QA report entry for a board that failed terminally: no artifact, error recorded, passed:false. */
function boardErrorReport(screenId: string, error: ContentEngineError): QaScreenReport {
  return {
    screenId,
    passed: false,
    // `flagged` mirrors `!passed` uniformly across every report; a failed board plainly needs a look.
    flagged: true,
    iterations: 0,
    score: 0,
    rubricScore: 0,
    penalty: 0,
    findings: [],
    routeHistory: [],
    error: { code: error.code, message: error.message },
  };
}

/** Per-board outcome: a rendered artifact, or a terminal failure captured by the bulkhead. */
type BoardResult = { readonly ok: FrozenScreen } | { readonly failed: QaScreenReport };

export interface ContentEngine {
  /** Turn a menu into finished signage screens. Validates input/output at the boundary. */
  generate(input: unknown): Promise<GenerateOutput>;
  /**
   * Resolve only the thin plan for an input (caller-supplied, else the Planner port), without
   * rendering. Lets a caller cache the plan and drive rendering board-by-board (e.g. resumable
   * runs that skip already-finished boards). Validated at the boundary.
   */
  plan(input: unknown): Promise<ThinPlan>;
}

function isRecursionError(error: unknown): boolean {
  return error instanceof Error && error.name === "GraphRecursionError";
}

/**
 * The composition root for the pure engine (build brief). Inject your ports and optional
 * config; the engine is stateless across calls (D15). Pass real adapters via
 * `createNodeEngine` (./node) or fakes via `createFakeEngine` (./testing).
 */
export function createEngine(ports: EnginePorts, config?: unknown): ContentEngine {
  const resolvedConfig: EngineConfig = loadEngineConfig(config);
  const ctx: NodeContext = { ports, config: resolvedConfig };
  const recursionLimit = recursionLimitFor(resolvedConfig.loop.maxIterations);

  /** Run the per-screen graph for one board of the plan; returns its frozen artifacts. */
  async function renderScreen(
    parsed: GenerateInput,
    plan: ThinPlan,
    index: number,
    runId: string,
  ): Promise<FrozenScreen> {
    const threadId = ports.idGenerator.next("run");
    ports.logger?.info(
      `▶ board ${index + 1}/${plan.screens.length} "${plan.screens[index]?.id ?? index}" — start`,
    );
    const graph = compileGraph(ctx);
    let finalState;
    try {
      finalState = await graph.invoke(
        { input: parsed, plan, screenIndex: index, runId },
        { configurable: { thread_id: threadId }, recursionLimit },
      );
    } catch (error) {
      if (isRecursionError(error)) {
        // The router must terminate the loop within budget (D12); hitting this is a bug.
        throw new ContentEngineError(
          "INTERNAL",
          `QA loop exceeded the recursion safety net without freezing (screen ${index}) — router termination bug.`,
          { cause: error },
        );
      }
      throw error;
    }
    if (!finalState.frozen) {
      throw new ContentEngineError(
        "INTERNAL",
        `engine finished without a frozen screen (index ${index}).`,
      );
    }
    return finalState.frozen;
  }

  /**
   * Menu data-quality lint at the boundary (D29): inspect the RAW input menu, then honour
   * `menuLint.mode`. `"reject"` throws a {@link ValidationError} listing the issues BEFORE any
   * planning/paint; `"warn"` (default) logs each and returns them to surface on the report;
   * `"off"` stays silent. Findings describe what's wrong with the INPUT (computed from the caller's
   * original items) — independent of the `zeroPriceRender` render transform. Both generate() and
   * plan() call this so `mode` is respected on either path.
   */
  function lintMenu(items: readonly CanonicalItem[]): MenuLintFinding[] {
    const menuLint = resolvedConfig.menuLint;
    const findings = runMenuLint(items, menuLint);
    if (menuLint.mode === "off" || findings.length === 0) return findings;
    if (menuLint.mode === "reject") {
      throw new ValidationError(
        `Menu failed data-quality lint (${findings.length} issue(s)): ${findings
          .map((f) => `${f.kind} on "${f.itemId}"`)
          .join("; ")}.`,
        { details: { findings } },
      );
    }
    ports.logger?.warn(
      `menu-lint: ${findings.length} data-quality issue(s) flagged (mode=warn — generation proceeds)`,
    );
    for (const f of findings)
      ports.logger?.warn(`menu-lint: [${f.kind}] ${f.itemId}: ${f.message}`);
    return findings;
  }

  /** Resolve + validate the thin plan (caller-supplied, else the Planner port). */
  async function resolvePlan(parsed: GenerateInput, runId: string): Promise<ThinPlan> {
    const correlation: RequestCorrelation = {
      runId,
      ...(parsed.brief.restaurant !== undefined ? { restaurant: parsed.brief.restaurant } : {}),
    };
    return parseOrThrow(
      thinPlanSchema,
      parsed.plan ?? (await ports.planner.plan(parsed, correlation)),
      "thin plan",
    );
  }

  return {
    async plan(input: unknown): Promise<ThinPlan> {
      const parsed = parseOrThrow(generateInputSchema, input, "generate input");
      // Respect menuLint.mode on the plan path too (reject throws, warn logs); the render policy
      // is a generate()-only concern (plan() produces no artifact), so it does not apply here (D29).
      lintMenu(parsed.items);
      return resolvePlan(parsed, ports.idGenerator.next("run"));
    },

    async generate(input: unknown): Promise<GenerateOutput> {
      const parsed = parseOrThrow(generateInputSchema, input, "generate input");

      // Menu data-quality lint at the boundary, BEFORE planning (D29): a "reject" mode throws here;
      // "warn" surfaces the findings on the report below. Computed from the caller's original items.
      const menuLintFindings = lintMenu(parsed.items);

      // Render policy (D29): under `zeroPriceRender:"hide"` strip zero/missing prices from the menu
      // so no `$0.00` ships and the required-`price`-binding QA check exempts the now-priceless item
      // (an item with no price is already exempt). The PLAN is still resolved from the ORIGINAL items
      // (prices don't affect allocation), so plan() and generate() produce identical plans.
      const renderItems = applyMenuRenderPolicy(parsed.items, resolvedConfig.menuLint);
      const forRender: GenerateInput =
        renderItems === parsed.items ? parsed : { ...parsed, items: renderItems };

      // One run id for the whole invocation: groups the planner + every board's calls under a
      // single trace id, while each board's session id stays distinct (D15, observability).
      const runId = ports.idGenerator.next("run");

      // The caller authors the allocation: one PlanScreen per board. Resolve the plan once
      // (caller-supplied, else the Planner port) and render every screen in it.
      const plan = await resolvePlan(parsed, runId);

      // A CALLER-AUTHORED plan must agree with `constraints.screens` (when a number) — the caller
      // owns that allocation (D5). When the Planner produced the plan, its board count is ELASTIC
      // (§ Phase 3): `constraints.screens` was only a hint the fit arithmetic may have adjusted, so
      // a mismatch is expected and NOT an error.
      const requested = parsed.constraints.screens;
      if (
        parsed.plan !== undefined &&
        typeof requested === "number" &&
        requested !== plan.screens.length
      ) {
        throw new UnsupportedConstraintError(
          `constraints.screens (${requested}) must match the plan's screen count (${plan.screens.length}).`,
          { details: { requested, planScreens: plan.screens.length } },
        );
      }

      // Render boards with bounded concurrency — each is an independent QA loop (own
      // thread/checkpointer/best). Results are written by index so screen order is preserved
      // regardless of completion order. Default concurrency is 1 (sequential, unchanged).
      //
      // BULKHEAD (D28): a single board's TERMINAL failure (PaintError after retries, RenderError,
      // LlmContractError, …) is contained to that board — it becomes an error report and the rest of
      // the fleet still ships. Only run-level / engine-invariant failures re-throw and abort the run.
      const results = new Array<BoardResult>(plan.screens.length);
      const workers = Math.max(
        1,
        Math.min(resolvedConfig.execution.boardConcurrency, plan.screens.length),
      );
      let nextIndex = 0;
      const runWorker = async (): Promise<void> => {
        for (let i = nextIndex++; i < plan.screens.length; i = nextIndex++) {
          try {
            results[i] = { ok: await renderScreen(forRender, plan, i, runId) };
          } catch (error) {
            if (!isBoardContainedError(error)) throw error;
            const screenId = plan.screens[i]?.id ?? `screen-${i + 1}`;
            ports.logger?.error(
              `board ${i + 1}/${plan.screens.length} "${screenId}" failed terminally (${error.code}) — shipping the rest of the fleet: ${error.message}`,
            );
            results[i] = { failed: boardErrorReport(screenId, error) };
          }
        }
      };
      await Promise.all(Array.from({ length: workers }, runWorker));

      // qaReport.screens is the authoritative per-board record (plan order, keyed by screenId);
      // screens[] and posters[] carry only the boards that succeeded. passedAll is false when any
      // board errored (an error report has passed:false).
      const screens: SelfContainedScreen[] = [];
      const posters: Poster[] = [];
      const screenReports: QaScreenReport[] = results.map((r) => {
        if ("ok" in r) {
          screens.push(r.ok.screen);
          posters.push(r.ok.poster);
          return r.ok.report;
        }
        return r.failed;
      });

      const output: GenerateOutput = {
        screens,
        posters,
        qaReport: {
          screens: screenReports,
          passedAll: screenReports.every((r) => r.passed),
          generatedAt: ports.clock.now().toISOString(),
          // Surface menu-lint findings when there was something to flag and the mode isn't "off"
          // (an omitted field reads as "lint clean / off") so evals can see e.g. a $0.00 price (D29).
          ...(resolvedConfig.menuLint.mode !== "off" && menuLintFindings.length > 0
            ? { menuLint: menuLintFindings }
            : {}),
        },
      };
      return parseOrThrow(generateOutputSchema, output, "generate output");
    },
  };
}
