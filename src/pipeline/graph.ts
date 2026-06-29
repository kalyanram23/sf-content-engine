import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";

import {
  deterministicQaNode,
  fetchImagesNode,
  freezeNode,
  packageNode,
  paintNode,
  planNode,
  repairNode,
  resolveThemeNode,
  scoreNode,
  visionQaNode,
} from "./nodes/index";
import { type EngineState, engineStateSchema, type NodeContext, type NodeFn } from "./state";

/**
 * The ONLY LangGraph-aware module (D2). It adapts the plain, LangGraph-free node functions
 * into a `StateGraph` with the §5.6 QA correction cycle and compiles it with a fresh
 * `MemorySaver` per call (D15). Node logic stays portable; only this file changes if the
 * orchestration runtime is ever swapped.
 */
export function compileGraph(ctx: NodeContext) {
  // Wrap every node with structured debug logging: which node ran, for which board + QA
  // iteration, and how long it took (timed via the Clock port — hermetic, no direct clock).
  // At debug level so normal runs stay quiet; `try --verbose` (or VERBOSE=1) prints the full
  // per-board pipeline timeline and surfaces exactly which node a failure came from.
  const bind =
    (name: string, fn: NodeFn) =>
    async (state: EngineState): Promise<Partial<EngineState>> => {
      const log = ctx.ports.logger;
      const startedMs = ctx.ports.clock.now().getTime();
      log?.debug(`→ ${name} (board ${state.screenIndex + 1}, iter ${state.iteration})`);
      try {
        const result = await fn(ctx, state);
        log?.debug(`← ${name} ${ctx.ports.clock.now().getTime() - startedMs}ms`);
        return result;
      } catch (error) {
        const ms = ctx.ports.clock.now().getTime() - startedMs;
        log?.debug(
          `✖ ${name} threw after ${ms}ms: ${error instanceof Error ? error.message : String(error)}`,
        );
        throw error;
      }
    };

  // Node ids must not collide with state channel names (e.g. the `plan` channel), so the
  // planning node is "planContent". The conditional-edge map keys are Route values.
  const builder = new StateGraph(engineStateSchema)
    .addNode("planContent", bind("planContent", planNode))
    .addNode("resolveTheme", bind("resolveTheme", resolveThemeNode))
    .addNode("fetchImages", bind("fetchImages", fetchImagesNode))
    .addNode("paint", bind("paint", paintNode))
    .addNode("package", bind("package", packageNode))
    .addNode("deterministicQA", bind("deterministicQA", deterministicQaNode))
    .addNode("visionQA", bind("visionQA", visionQaNode))
    .addNode("score", bind("score", scoreNode))
    .addNode("repair", bind("repair", repairNode))
    .addNode("freeze", bind("freeze", freezeNode))
    .addEdge(START, "planContent")
    .addEdge("planContent", "resolveTheme")
    .addEdge("resolveTheme", "fetchImages")
    .addEdge("fetchImages", "paint")
    .addEdge("paint", "package")
    .addEdge("repair", "package")
    .addEdge("package", "deterministicQA")
    .addEdge("deterministicQA", "visionQA")
    .addEdge("visionQA", "score")
    // The §5.6 hybrid routing cycle — the router (in score) is the sole termination authority.
    .addConditionalEdges("score", (state: EngineState) => state.route ?? "freeze", {
      repair: "repair",
      paint: "paint",
      plan: "planContent",
      freeze: "freeze",
    })
    .addEdge("freeze", END);

  return builder.compile({ checkpointer: new MemorySaver() });
}

/** A safe `recursionLimit` derived from the budget — a pure safety net, not the budget (D12). */
export function recursionLimitFor(maxIterations: number): number {
  // ~6 node transitions per QA cycle + setup/freeze slack (incl. the one-time fetchImages hop).
  return maxIterations * 6 + 14;
}
