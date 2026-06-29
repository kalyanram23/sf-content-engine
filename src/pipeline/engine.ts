import { type EngineConfig, loadEngineConfig } from "../config/index";
import { ContentEngineError, UnsupportedConstraintError } from "../domain/errors";
import { parseOrThrow } from "../domain/parse";
import { generateInputSchema, generateOutputSchema, thinPlanSchema } from "../domain/schemas";
import type { GenerateInput, GenerateOutput, ThinPlan } from "../domain/types";
import type { EnginePorts } from "../ports/index";
import { compileGraph, recursionLimitFor } from "./graph";
import type { FrozenScreen, NodeContext } from "./state";

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
  ): Promise<FrozenScreen> {
    const threadId = ports.idGenerator.next("run");
    ports.logger?.info(
      `▶ board ${index + 1}/${plan.screens.length} "${plan.screens[index]?.id ?? index}" — start`,
    );
    const graph = compileGraph(ctx);
    let finalState;
    try {
      finalState = await graph.invoke(
        { input: parsed, plan, screenIndex: index },
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

  /** Resolve + validate the thin plan (caller-supplied, else the Planner port). */
  async function resolvePlan(parsed: GenerateInput): Promise<ThinPlan> {
    return parseOrThrow(
      thinPlanSchema,
      parsed.plan ?? (await ports.planner.plan(parsed)),
      "thin plan",
    );
  }

  return {
    async plan(input: unknown): Promise<ThinPlan> {
      const parsed = parseOrThrow(generateInputSchema, input, "generate input");
      return resolvePlan(parsed);
    },

    async generate(input: unknown): Promise<GenerateOutput> {
      const parsed = parseOrThrow(generateInputSchema, input, "generate input");

      // The caller authors the allocation: one PlanScreen per board. Resolve the plan once
      // (caller-supplied, else the Planner port) and render every screen in it.
      const plan = await resolvePlan(parsed);

      // `constraints.screens` (when a number) must agree with the plan's board count.
      const requested = parsed.constraints.screens;
      if (typeof requested === "number" && requested !== plan.screens.length) {
        throw new UnsupportedConstraintError(
          `constraints.screens (${requested}) must match the plan's screen count (${plan.screens.length}).`,
          { details: { requested, planScreens: plan.screens.length } },
        );
      }

      // Render boards sequentially — each is an independent QA loop (own thread/checkpointer).
      const frozen: FrozenScreen[] = [];
      for (let i = 0; i < plan.screens.length; i += 1) {
        frozen.push(await renderScreen(parsed, plan, i));
      }

      const output: GenerateOutput = {
        screens: frozen.map((f) => f.screen),
        posters: frozen.map((f) => f.poster),
        qaReport: {
          screens: frozen.map((f) => f.report),
          passedAll: frozen.every((f) => f.report.passed),
          generatedAt: ports.clock.now().toISOString(),
        },
      };
      return parseOrThrow(generateOutputSchema, output, "generate output");
    },
  };
}
