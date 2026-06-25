import type OpenAI from "openai";

import { repairResponseSchema, type RepairResponse } from "../../domain/contracts";
import type { LlmRepairer, LlmRepairRequest } from "../../ports/repairer";
import { requestStructured } from "./client";

const SYSTEM = `You apply a MINIMAL mechanical fix to an HTML signage screen to resolve the given QA findings, changing nothing else. Keep colours/spacing on the theme tokens (no raw hex/px). Return the full corrected HTML in "html" and a one-line "note".`;

/**
 * Optional LLM-backed repairer via OpenRouter (D13). The engine prefers pure deterministic
 * repairs and only reaches this when none apply. Model id comes from `ModelRouting.repair`.
 */
export class OpenRouterRepairer implements LlmRepairer {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
  ) {}

  repair(request: LlmRepairRequest): Promise<RepairResponse> {
    return requestStructured(this.client, {
      model: this.model,
      schema: repairResponseSchema,
      schemaName: "repair",
      system: SYSTEM,
      user: `Theme tokens: ${JSON.stringify(request.theme.tokens.colors)}
Findings: ${JSON.stringify(request.findings.map((f) => ({ kind: f.kind, message: f.message, region: f.region })))}
HTML:
${request.html}`,
    });
  }
}
