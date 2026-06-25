import type { Severity } from "./types";

/** Severity ordered weakest → strongest. */
export const SEVERITY_ORDER = [
  "info",
  "minor",
  "major",
  "critical",
] as const satisfies readonly Severity[];

export function severityRank(severity: Severity): number {
  return SEVERITY_ORDER.indexOf(severity);
}

export function severityAtLeast(severity: Severity, min: Severity): boolean {
  return severityRank(severity) >= severityRank(min);
}
