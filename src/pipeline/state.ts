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
  /**
   * Whether this candidate's iteration was vision-critiqued (false when the paid pass was SKIPPED
   * because deterministic QA already gate-blocked it — D27). Lets `freeze` distinguish an
   * un-critiqued shipped candidate (which would otherwise ship with ZERO vision findings and a
   * vacuous rubricScore of 1.00) from a critiqued-but-clean one, so it runs ONE make-good critique
   * on the former only (freeze-path critique).
   */
  critiqued: z.boolean().default(false),
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
  /**
   * Whether THIS iteration's candidate has been vision-critiqued. `deterministicQA` resets it to
   * false each iteration (alongside the fresh findings); `visionQA` sets it true only when it
   * actually runs the critic (it stays false when the paid pass is skipped on a gate-blocked
   * iteration — D27). `score` snapshots it onto `best.critiqued` so `freeze` can run a single
   * make-good critique on a shipped candidate that never received one.
   */
  visionCritiqued: z.boolean().default(false),
  /** Paint/repair cycles performed for this screen. */
  iteration: z.number().int().default(0),
  /**
   * True when the most recent repair produced HTML byte-identical to its input — a no-progress
   * repair (e.g. a deterministic fix that re-emits an already-present block, or an LLM repair that
   * returned the same markup). The router suppresses repair-routing rules while this is set so the
   * decision escalates to a re-paint instead of re-choosing a repair that provably changes nothing
   * (the "repair-loop dead-end", D65). `paint` clears it (a fresh paint makes repair viable again).
   */
  repairIneffective: z.boolean().default(false),
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
