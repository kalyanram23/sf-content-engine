/**
 * Routes each paint to the composition path when the theme names a registered vocabulary
 * (and mode !== "free"), else to the free painter. Pure; both painters are injected.
 *
 * RESCUE (production resilience): in "auto" mode a composition-path failure (composer API error
 * after its retry, vocabulary render throw) falls back to the free painter for THAT board — the
 * board still ships, it just costs free-paint prices that once. The failure is logged as a warning
 * with the board correlation. Forced "composition" mode does NOT rescue (surfacing the error is
 * the point of forcing the mode — CI/debug use).
 */

import type { Logger, Painter, VocabularyRegistry } from "../ports/index";
import type { PaintRequest } from "../ports/painter";

export class AutoPainter implements Painter {
  constructor(
    private readonly deps: {
      free: Painter;
      composition: Painter;
      vocabularies: VocabularyRegistry;
      mode: "auto" | "free" | "composition";
      logger?: Logger;
    },
  ) {}
  async paint(request: PaintRequest): Promise<string> {
    const { mode, vocabularies, free, composition, logger } = this.deps;
    const vocabId = request.theme.vocabulary;
    const hasVocab = vocabId !== undefined && vocabularies.get(vocabId) !== undefined;
    if (mode === "composition") return composition.paint(request);
    if (mode === "auto" && hasVocab) {
      try {
        return await composition.paint(request);
      } catch (error) {
        logger?.warn(
          `composition paint failed — rescuing with free paint: ${error instanceof Error ? error.message : String(error)}`,
        );
        return free.paint(request);
      }
    }
    return free.paint(request);
  }
}
