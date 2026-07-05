import type { VisionRubricConfig } from "../config/rubric";
import type { CritiqueResponse } from "../domain/contracts";
import type { DensityTier, PlanScreen } from "../domain/types";
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
  /**
   * The board's density tier + item count (D30). For a `dense`/`packed` board the critic is told to
   * judge theme-adherence and intentional-design against a COMPACT information-dense register (a
   * well-executed dense price wall), not boutique-whitespace expectations — the density is forced by
   * the plan, so a tight, hero-less board is correct, not a flaw. Absent/`comfortable` → no shift.
   */
  densityTier?: DensityTier;
  /** The number of menu items on this board — context for judging the density tier. */
  itemCount?: number;
  /**
   * The exact canvas the screenshot was rendered at + its aspect, so the critic judges fill,
   * balance and hierarchy for THIS orientation (a portrait 9:16 board is composed and judged
   * differently from a landscape 16:9 one). Derived from `constraints.aspect` (D19).
   */
  canvas?: { width: number; height: number; aspect: "16:9" | "9:16" };
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
