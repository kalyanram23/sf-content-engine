import { END, MemorySaver, START, StateGraph } from "@langchain/langgraph";

import {
  deterministicQaNode,
  freezeNode,
  packageNode,
  paintNode,
  planNode,
  repairNode,
  resolveThemeNode,
  scoreNode,
  visionQaNode,
} from "./nodes/index";
import { type EngineState, engineStateSchema, type NodeContext } from "./state";

/**
 * The ONLY LangGraph-aware module (D2). It adapts the plain, LangGraph-free node functions
 * into a `StateGraph` with the §5.6 QA correction cycle and compiles it with a fresh
 * `MemorySaver` per call (D15). Node logic stays portable; only this file changes if the
 * orchestration runtime is ever swapped.
 */
export function compileGraph(ctx: NodeContext) {
  const bind =
    (fn: (ctx: NodeContext, state: EngineState) => Promise<Partial<EngineState>>) =>
    (state: EngineState) =>
      fn(ctx, state);

  // Node ids must not collide with state channel names (e.g. the `plan` channel), so the
  // planning node is "planContent". The conditional-edge map keys are Route values.
  const builder = new StateGraph(engineStateSchema)
    .addNode("planContent", bind(planNode))
    .addNode("resolveTheme", bind(resolveThemeNode))
    .addNode("paint", bind(paintNode))
    .addNode("package", bind(packageNode))
    .addNode("deterministicQA", bind(deterministicQaNode))
    .addNode("visionQA", bind(visionQaNode))
    .addNode("score", bind(scoreNode))
    .addNode("repair", bind(repairNode))
    .addNode("freeze", bind(freezeNode))
    .addEdge(START, "planContent")
    .addEdge("planContent", "resolveTheme")
    .addEdge("resolveTheme", "paint")
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
  // ~6 node transitions per QA cycle + setup/freeze slack.
  return maxIterations * 6 + 12;
}
