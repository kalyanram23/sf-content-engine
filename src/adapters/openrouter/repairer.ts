import type OpenAI from "openai";

import type { ReasoningSetting } from "../../config/models";
import { repairResponseSchema, type RepairResponse } from "../../domain/contracts";
import type { LlmRepairer, LlmRepairRequest } from "../../ports/repairer";
import { requestStructured } from "./client";
import { buildBroadcast } from "./correlation";

export const SYSTEM = `You apply a MINIMAL mechanical fix to an HTML signage screen to resolve the given QA findings, changing nothing else. Keep colours/spacing on the theme tokens (no raw hex/px). Return the full corrected HTML in "html" and a one-line "note".`;

/** Build the repair user prompt: theme tokens + the findings to fix + the HTML to patch. */
export function describeRepairRequest(request: LlmRepairRequest): string {
  return `Theme tokens: ${JSON.stringify(request.theme.tokens.colors)}
Findings: ${JSON.stringify(request.findings.map((f) => ({ kind: f.kind, message: f.message, region: f.region })))}
HTML:
${request.html}`;
}

/**
 * Optional LLM-backed repairer via OpenRouter (D13). The engine prefers pure deterministic
 * repairs and only reaches this when none apply. Model id comes from `ModelRouting.repair`.
 */
export class OpenRouterRepairer implements LlmRepairer {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
    private readonly reasoning?: ReasoningSetting,
  ) {}

  repair(request: LlmRepairRequest): Promise<RepairResponse> {
    return requestStructured(this.client, {
      model: this.model,
      schema: repairResponseSchema,
      schemaName: "repair",
      system: SYSTEM,
      user: describeRepairRequest(request),
      ...(this.reasoning !== undefined ? { reasoning: this.reasoning } : {}),
      ...buildBroadcast(request.correlation, "repair"),
    });
  }
}
