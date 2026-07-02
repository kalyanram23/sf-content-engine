import type { VisionRubricConfig } from "../config/rubric";
import type { CritiqueResponse } from "../domain/contracts";
import type { PlanScreen } from "../domain/types";
import type { RequestCorrelation } from "./correlation";

export interface CritiqueRequest {
  /** Base64 PNG screenshot of the packaged, rendered screen. */
  screenshotBase64: string;
  /** The plan slice — so the critic knows what *should* be present (spec §5.6). */
  planScreen: PlanScreen;
  /** The rubric the critic must score against (structured output). */
  rubric: VisionRubricConfig;
  /**
   * Distilled theme intent (identity, density, motif — prose only, never token hex or asset
   * data). Lets the critic grade theme-adherence/intentional-design against what the theme
   * actually asked for instead of a generic notion of "designed".
   */
  designIntent?: string;
  /** The layout strategy the painter was told to follow — graded against, not guessed at. */
  layoutStrategy?: string;
  /** Observability correlation for this call (run/board/iteration), threaded to OpenRouter Broadcast. */
  correlation?: RequestCorrelation;
}

/**
 * The cheap-VLM vision pass (spec §5.6). Returns findings forced into the rubric via
 * structured output; the adapter validates the response against the contract (D11).
 */
export interface VisionCritic {
  critique(request: CritiqueRequest): Promise<CritiqueResponse>;
}
