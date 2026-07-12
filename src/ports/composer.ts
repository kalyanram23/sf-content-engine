import type { CompositionResponse } from "../domain/contracts";
import type { RequestCorrelation } from "./correlation";

export interface ComposeRequest {
  /** Compact board-content digest: sections, item names+prices, photo-eligible ids. */
  digest: string;
  /** Vocabulary-aware prompt block (block kinds + the theme's promptNotes). */
  vocabularyPrompt: string;
  canvas: { width: number; height: number };
  /** On a re-compose after QA findings: the findings to address, human-readable. */
  findingsNote?: string;
  correlation?: RequestCorrelation;
}

/**
 * The composition LLM (D71): fills the strict order form (compositionResponseSchema) — judgment
 * only (block order, grouping, photo picks, board title). Structured outputs enforce the shape;
 * the renderer enforces coverage + photo-truth regardless of what comes back.
 */
export interface Composer {
  compose(request: ComposeRequest): Promise<CompositionResponse>;
}
