import type { VisionRubricConfig } from "../config/rubric";
import type { CritiqueResponse } from "../domain/contracts";
import type { PlanScreen } from "../domain/types";

export interface CritiqueRequest {
  /** Base64 PNG screenshot of the packaged, rendered screen. */
  screenshotBase64: string;
  /** The plan slice — so the critic knows what *should* be present (spec §5.6). */
  planScreen: PlanScreen;
  /** The rubric the critic must score against (structured output). */
  rubric: VisionRubricConfig;
}

/**
 * The cheap-VLM vision pass (spec §5.6). Returns findings forced into the rubric via
 * structured output; the adapter validates the response against the contract (D11).
 */
export interface VisionCritic {
  critique(request: CritiqueRequest): Promise<CritiqueResponse>;
}
