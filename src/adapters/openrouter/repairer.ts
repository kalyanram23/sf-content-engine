import type OpenAI from "openai";

import type { ReasoningSetting } from "../../config/models";
import { repairResponseSchema, type RepairResponse } from "../../domain/contracts";
import type { LlmRepairer, LlmRepairRequest } from "../../ports/repairer";
import type { Logger, UsageSink } from "../../ports/services";
import { serializeFindingsForPrompt } from "../../qa/finding";
import {
  buildUsageReporter,
  requestStructured,
  resilienceFields,
  type RoleResilience,
} from "./client";
import { buildBroadcast } from "./correlation";
import { REF_INSTRUCTION } from "./painter";

export const SYSTEM = `You apply a MINIMAL mechanical fix to an HTML signage screen to resolve the given QA findings, changing nothing else. Keep colours/spacing on the theme tokens (no raw hex/px). Return the full corrected HTML in "html" and a one-line "note".`;

/** Build the repair user prompt: theme tokens + the element-anchored findings to fix + the HTML to
 * patch. Findings carry their machine-precise anchors (overshoot px, contrast ratio, element refs)
 * so the repairer can target the exact offending elements. */
export function describeRepairRequest(request: LlmRepairRequest): string {
  return `Theme tokens: ${JSON.stringify(request.theme.tokens.colors)}
Findings:
${serializeFindingsForPrompt(request.findings)}
${REF_INSTRUCTION}
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
    private readonly logger?: Logger,
    private readonly reasoning?: ReasoningSetting,
    private readonly maxTokens?: number,
    private readonly resilience?: RoleResilience,
    private readonly usage?: UsageSink,
  ) {}

  repair(request: LlmRepairRequest): Promise<RepairResponse> {
    const onUsage = buildUsageReporter(this.logger, this.usage, "repair", this.model);
    return requestStructured(this.client, {
      model: this.model,
      schema: repairResponseSchema,
      schemaName: "repair",
      system: SYSTEM,
      user: describeRepairRequest(request),
      ...(this.reasoning !== undefined ? { reasoning: this.reasoning } : {}),
      ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
      ...resilienceFields(this.resilience),
      ...(onUsage !== undefined ? { onUsage } : {}),
      ...buildBroadcast(request.correlation, "repair"),
    });
  }
}
