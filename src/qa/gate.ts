import { severityAtLeast } from "../domain/severity";
import type { QaFinding, Severity } from "../domain/types";

/**
 * The single pass/block predicate (extracted from scoring so the policy is one auditable
 * expression). Deterministic findings (overflow/density/binding/token-lint) and hard gates
 * (contrast/viewport) block a pass. VISION (critic) quality is graded by the weighted rubric
 * instead — a single reflexive critic nit ("balance: some dead space") must not hard-block an
 * otherwise-good screen; a genuinely poor screen still fails because enough rubric dimensions
 * drop it below threshold (or a `blocking` rubric dimension fails — see scoring).
 */

export interface GateDecision {
  /** True when the candidate can never pass this iteration (hard gate or blocking deterministic finding). */
  blocking: boolean;
  /** Count of hard-gate failures (e.g. WCAG contrast); these dominate the score ordering. */
  hardGateFailures: number;
}

export function decideGate(
  findings: readonly QaFinding[],
  blockingSeverity: Severity,
): GateDecision {
  const hardGateFailures = findings.filter((f) => f.hardGate).length;
  const blocking =
    hardGateFailures > 0 ||
    findings.some(
      (f) => f.source === "deterministic" && severityAtLeast(f.severity, blockingSeverity),
    );
  return { blocking, hardGateFailures };
}
