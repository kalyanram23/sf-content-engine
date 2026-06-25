import type { LoopConfig, Route, RoutingMatch, RoutingRules } from "../config/index";
import { severityAtLeast } from "../domain/severity";
import type { QaFinding } from "../domain/types";

/**
 * The §5.6 hybrid routing evaluator — PURE and the SOLE termination authority (D12).
 * `recursionLimit` in the graph is only a safety net; this function decides when the loop
 * stops by returning "freeze" the instant the iteration budget is spent.
 */

export interface RouteInput {
  findings: readonly QaFinding[];
  /** Number of paint/repair cycles already performed for this screen. */
  iteration: number;
}

function matches(finding: QaFinding, when: RoutingMatch): boolean {
  if (when.source !== undefined && finding.source !== when.source) return false;
  if (when.kindAnyOf !== undefined && !when.kindAnyOf.includes(finding.kind)) return false;
  if (when.tagAnyOf !== undefined && !when.tagAnyOf.includes(finding.tag)) return false;
  if (when.minSeverity !== undefined && !severityAtLeast(finding.severity, when.minSeverity))
    return false;
  if (
    when.deterministicallyFixable !== undefined &&
    finding.deterministicallyFixable !== when.deterministicallyFixable
  ) {
    return false;
  }
  return true;
}

/** The highest-priority rule with at least one matching finding, or null if none match. */
function selectRoute(findings: readonly QaFinding[], routing: RoutingRules): Route | null {
  const ordered = [...routing.rules].sort((a, b) => b.priority - a.priority);
  for (const rule of ordered) {
    if (findings.some((f) => matches(f, rule.when))) return rule.route;
  }
  return null;
}

export function route(input: RouteInput, routing: RoutingRules, loop: LoopConfig): Route {
  // Budget is enforced here, before any re-entry into paint/repair (spec §5.6, D12).
  if (input.iteration >= loop.maxIterations) return "freeze";
  return selectRoute(input.findings, routing) ?? "freeze";
}
