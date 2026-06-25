import type { VisionRubricConfig } from "../config/rubric";
import { severityAtLeast } from "../domain/severity";
import type { QaFinding, Severity } from "../domain/types";

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

/** Weighted fraction of rubric dimensions that did not fail (spec §5.6 vision pass). */
export function rubricScore(findings: readonly QaFinding[], rubric: VisionRubricConfig): number {
  const totalWeight = rubric.dimensions.reduce((sum, d) => sum + d.weight, 0);
  if (totalWeight === 0) return 1;
  let passWeight = 0;
  for (const dim of rubric.dimensions) {
    const failed = findings.some(
      (f) =>
        f.source === "vision" &&
        f.kind === dim.id &&
        severityAtLeast(f.severity, dim.failAtSeverity),
    );
    if (!failed) passWeight += dim.weight;
  }
  return passWeight / totalWeight;
}

export function scoreScreen(
  findings: readonly QaFinding[],
  rubric: VisionRubricConfig,
  blockingSeverity: Severity = DEFAULT_BLOCKING_SEVERITY,
): ScreenScore {
  const penalty = findings.reduce((sum, f) => sum + SEVERITY_PENALTY[f.severity], 0);
  const hardGateFailures = findings.filter((f) => f.hardGate).length;
  const rubric01 = rubricScore(findings, rubric);
  const blocking = findings.some((f) => severityAtLeast(f.severity, blockingSeverity));
  const passed = !blocking && rubric01 >= rubric.passThreshold;
  // Ordering: hard gates dominate, then total penalty, then rubric score as the tiebreak.
  const total = -hardGateFailures * 1_000_000 - penalty * 1_000 + rubric01;
  return { total, rubricScore: rubric01, penalty, hardGateFailures, passed };
}

/** True when `candidate` is strictly better than `incumbent` (used to maintain `best`). */
export function isBetter(candidate: ScreenScore, incumbent: ScreenScore): boolean {
  return candidate.total > incumbent.total;
}
