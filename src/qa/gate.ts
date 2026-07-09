import { severityAtLeast } from "../domain/severity";
import type { QaFinding, Severity } from "../domain/types";

/**
 * The single pass/block predicate (extracted from scoring so the policy is one auditable
 * expression). Deterministic findings (overflow/density/binding/token-lint) and hard gates
 * (contrast/viewport) block a pass.
 *
 * VISION (critic) severity below `critical` is graded by the weighted rubric, NOT hard-blocked:
 * a single reflexive critic nit ("balance: some dead space") — or even a real `major` — must not
 * hard-block an otherwise-good screen; a genuinely poor screen still fails because enough rubric
 * dimensions drop it below threshold (or a `blocking` rubric dimension fails — see scoring). This
 * tolerance dates to the noisy cheap-VLM era, where reflexive false positives were common and any
 * single critic finding blocking would have been unshippable.
 *
 * A vision `critical` DOES block (D69). The critic is now a frontier judge whose rare criticals
 * are real, actionable ship-blockers ("last row clipped at the canvas edge") — not variance. So
 * exactly-critical vision findings hard-block; `major`-and-below vision findings keep their
 * rubric-graded, variance-tolerant treatment (the wanted asymmetry). The gate never sees vision
 * findings at the visionQA-skip site — they are appended only AFTER the skip decision — so this
 * clause cannot make the vision pass skip itself.
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
    ) ||
    // A frontier judge's CRITICAL vision finding is a real ship-blocker (D69). Exactly critical:
    // vision majors stay rubric-graded (variance tolerance is still wanted). `critical` is the top
    // of SEVERITY_ORDER, so the equality check and `severityAtLeast(_, "critical")` coincide — the
    // equality reads as the deliberate "critical only, not major".
    findings.some((f) => f.source === "vision" && f.severity === "critical");
  return { blocking, hardGateFailures };
}
