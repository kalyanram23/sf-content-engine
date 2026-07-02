import type { RepairResponse } from "../domain/contracts";
import type { QaFinding, ResolvedTheme } from "../domain/types";
import type { RequestCorrelation } from "./correlation";

export interface LlmRepairRequest {
  html: string;
  theme: ResolvedTheme;
  /** The mechanical findings to fix. */
  findings: QaFinding[];
  /** Observability correlation for this call (run/board/iteration), threaded to OpenRouter Broadcast. */
  correlation?: RequestCorrelation;
}

/**
 * Optional LLM-backed mechanical repair (D13). Deterministic repairs (contrast token-swap,
 * overflow trim) are pure functions in `repairs/` and are tried first; this port is only
 * reached when no deterministic fix applies. Reserved/optional in v1.
 */
export interface LlmRepairer {
  repair(request: LlmRepairRequest): Promise<RepairResponse>;
}
