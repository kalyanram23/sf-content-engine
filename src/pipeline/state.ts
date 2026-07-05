import { z } from "zod";

import type { EngineConfig } from "../config/index";
import { routeSchema } from "../config/index";
import {
  canonicalItemSchema,
  generateInputSchema,
  posterSchema,
  qaFindingSchema,
  qaScreenReportSchema,
  resolvedThemeSchema,
  selfContainedScreenSchema,
  thinPlanSchema,
} from "../domain/schemas";
import type { EnginePorts } from "../ports/index";

/** The best-scoring candidate so far — maintained by an explicit max in the score node (D12). */
export const bestCandidateSchema = z.object({
  html: z.string(),
  packagedHtml: z.string(),
  screenshotBase64: z.string(),
  findings: z.array(qaFindingSchema),
  /** Comparable total from the scoring comparator; higher is better. */
  score: z.number(),
  /** Human-meaningful weighted rubric pass fraction in [0,1] — persisted into the report (D28). */
  rubricScore: z.number(),
  /** Summed severity penalty of all findings — persisted into the report (D28). */
  penalty: z.number(),
  passed: z.boolean(),
  iterations: z.number().int(),
});

/** The frozen artifacts produced by the freeze node (spec §3 outputs, for one screen). */
export const frozenScreenSchema = z.object({
  screen: selfContainedScreenSchema,
  poster: posterSchema,
  report: qaScreenReportSchema,
});

/**
 * The screen-in-progress graph state (spec §5.7). Distinct from the strict LLM contracts
 * (D2). Channels are last-value-wins; `best` is maintained by an explicit comparator in the
 * score node, and `iteration` is incremented by paint/repair (D9/D12).
 */
export const engineStateSchema = z.object({
  /** Constant for the run. */
  input: generateInputSchema,
  /** Which plan screen this run paints (0-based). The engine runs the graph once per screen. */
  screenIndex: z.number().int().nonnegative().default(0),
  /** Stable id for the whole run (seeded by the engine); threaded to LLM calls for trace correlation. */
  runId: z.string().optional(),
  plan: thinPlanSchema.optional(),
  theme: resolvedThemeSchema.optional(),
  /**
   * The current screen's items with every image reference resolved to an offline-safe
   * data-URI (set once by `fetchImages` before paint). Downstream nodes prefer this over
   * `input.items` so paint/QA/package never see a remote URL. Scoped to the screen's items.
   */
  resolvedItems: z.array(canonicalItemSchema).optional(),
  /** Current raw painter output (pre-package). */
  html: z.string().optional(),
  /** Current self-contained, packaged artifact (what QA renders). */
  packagedHtml: z.string().optional(),
  /** Screenshot of the most recent render (poster candidate). */
  screenshotBase64: z.string().optional(),
  /** Findings from the most recent QA passes (deterministic ∪ vision). */
  findings: z.array(qaFindingSchema).default([]),
  /** Paint/repair cycles performed for this screen. */
  iteration: z.number().int().default(0),
  /** Most recent routing decision (set by the score node; read by the conditional edge). */
  route: routeSchema.optional(),
  routeHistory: z.array(z.string()).default([]),
  best: bestCandidateSchema.optional(),
  frozen: frozenScreenSchema.optional(),
});

export type BestCandidate = z.infer<typeof bestCandidateSchema>;
export type FrozenScreen = z.infer<typeof frozenScreenSchema>;
export type EngineState = z.infer<typeof engineStateSchema>;

/** Everything a node needs beyond the state: injected ports + validated config. */
export interface NodeContext {
  ports: EnginePorts;
  config: EngineConfig;
}

/** A pipeline node: pure over (ctx, state), LangGraph-free (D2). */
export type NodeFn = (ctx: NodeContext, state: EngineState) => Promise<Partial<EngineState>>;
