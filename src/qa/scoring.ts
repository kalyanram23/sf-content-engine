import type { RubricDimension, VisionRubricConfig } from "../config/rubric";
import { severityAtLeast } from "../domain/severity";
import type { QaFinding, Severity } from "../domain/types";
import { decideGate } from "./gate";

/**
 * Scoring + the total-order comparator (D12). `best`-by-score is maintained by an explicit
 * max over this comparator so a worse later iteration never destroys the best (spec §5.6
 * "ship the best-scoring screen"). Higher `total` is better.
 */

const SEVERITY_PENALTY: Record<Severity, number> = { info: 0, minor: 1, major: 3, critical: 10 };

/** Default blocking threshold when none is supplied (matches `QaConfig.blockingSeverity`). */
const DEFAULT_BLOCKING_SEVERITY: Severity = "major";

export interface ScreenScore {
  /** Single comparable number; higher is better. Encodes the ordering below. */
  total: number;
  /** Weighted rubric pass fraction in [0,1] (higher better). */
  rubricScore: number;
  /** Summed severity penalty of all findings (lower better). */
  penalty: number;
  /** Count of hard-gate failures (e.g. WCAG contrast); these dominate the ordering. */
  hardGateFailures: number;
  /** Whether the screen satisfies QA (no blocking findings + rubric threshold met). */
  passed: boolean;
}

/** True when a vision finding fails this rubric dimension (at/above its fail severity). */
function dimensionFailed(findings: readonly QaFinding[], dim: RubricDimension): boolean {
  return findings.some(
    (f) =>
      f.source === "vision" && f.kind === dim.id && severityAtLeast(f.severity, dim.failAtSeverity),
  );
}

/** Weighted fraction of rubric dimensions that did not fail (spec §5.6 vision pass). */
export function rubricScore(findings: readonly QaFinding[], rubric: VisionRubricConfig): number {
  const totalWeight = rubric.dimensions.reduce((sum, d) => sum + d.weight, 0);
  if (totalWeight === 0) return 1;
  let passWeight = 0;
  for (const dim of rubric.dimensions) {
    if (!dimensionFailed(findings, dim)) passWeight += dim.weight;
  }
  return passWeight / totalWeight;
}

export function scoreScreen(
  findings: readonly QaFinding[],
  rubric: VisionRubricConfig,
  blockingSeverity: Severity = DEFAULT_BLOCKING_SEVERITY,
): ScreenScore {
  const penalty = findings.reduce((sum, f) => sum + SEVERITY_PENALTY[f.severity], 0);
  const rubric01 = rubricScore(findings, rubric);
  // The pass/block policy lives in decideGate (qa/gate.ts) — one auditable predicate shared
  // with anything else that needs the decision. On top of the gate, a rubric dimension marked
  // `blocking: true` fails the pass on its own when it fails hard — so a craft-critical
  // dimension (e.g. hierarchy) can drive the loop without every critic nit doing so.
  const { blocking, hardGateFailures } = decideGate(findings, blockingSeverity);
  const failedBlockingDimension = rubric.dimensions.some(
    (dim) => dim.blocking && dimensionFailed(findings, dim),
  );
  const passed = !blocking && !failedBlockingDimension && rubric01 >= rubric.passThreshold;
  // Ordering: hard gates dominate, then total penalty, then rubric score as the tiebreak.
  const total = -hardGateFailures * 1_000_000 - penalty * 1_000 + rubric01;
  return { total, rubricScore: rubric01, penalty, hardGateFailures, passed };
}

/** True when `candidate` is strictly better than `incumbent` (used to maintain `best`). */
export function isBetter(candidate: ScreenScore, incumbent: ScreenScore): boolean {
  return candidate.total > incumbent.total;
}
