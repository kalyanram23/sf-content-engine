/**
 * CompositionPainter (D71) — the core class that makes the composition path a drop-in {@link Painter}.
 *
 * Pure orchestration over injected ports: build the id-free content digest + vocabulary prompt from
 * the plan screen, ask the {@link Composer} LLM for JUDGMENT (block order, grouping, photo picks,
 * title), then hand that to the deterministic {@link renderComposed} — which guarantees coverage,
 * enforces photo-truth, and expands the theme's closed component vocabulary into one engine-legal
 * board. No adapter imports, no IO of its own (the browser `measure` is an injected port); no layout
 * numbers live here — every theme touchpoint is reached through the {@link ComponentVocabulary}.
 *
 * On a re-paint the QA findings become a re-COMPOSE note (the composer picks a different arrangement)
 * rather than an HTML repair: the composition path never edits HTML.
 */

import { PaintError } from "../domain/errors";
import type { BrowserPort } from "../ports/browser";
import type { Composer } from "../ports/composer";
import type { Logger, Painter, VocabularyRegistry } from "../ports/index";
import type { PaintRequest } from "../ports/painter";
import type { PhotoBandMode } from "../ports/vocabulary-registry";
import { buildComposerContent } from "./digest";
import { renderComposed } from "./renderer";

const DEFAULT_CANVAS = { width: 1080, height: 1920 };

export class CompositionPainter implements Painter {
  constructor(
    private readonly deps: {
      composer: Composer;
      vocabularies: VocabularyRegistry;
      browser: Pick<BrowserPort, "measure">;
      logger?: Logger;
      /** Override every theme's default photo mode (config knob); undefined = theme default. */
      photoMode?: PhotoBandMode;
    },
  ) {}

  async paint(request: PaintRequest): Promise<string> {
    const { composer, vocabularies, browser, logger } = this.deps;

    // 1–2. Resolve the theme's vocabulary; a missing/unregistered id fails loud (the AutoPainter
    // keeps free themes from ever reaching here).
    const vocabId = request.theme.vocabulary;
    if (vocabId === undefined) {
      throw new PaintError("composition paint requires theme.vocabulary to be set.");
    }
    const vocab = vocabularies.get(vocabId);
    if (vocab === undefined) {
      throw new PaintError(`composition paint: no registered vocabulary "${vocabId}".`);
    }

    // 3. Content digest + vocabulary prompt from the plan screen.
    const { sections, photoCandidates, digest, vocabularyPrompt } = buildComposerContent({
      planScreen: request.planScreen,
      items: request.items,
      vocab,
    });

    // 4. Compose — JUDGMENT only. On a re-paint the findings become a re-compose note.
    const canvas = request.viewport ?? DEFAULT_CANVAS;
    const findingsNote =
      request.findings && request.findings.length > 0
        ? request.findings.map((f) => `- ${f.message}`).join("\n")
        : undefined;
    const composition = await composer.compose({
      digest,
      vocabularyPrompt,
      canvas,
      ...(findingsNote !== undefined ? { findingsNote } : {}),
      ...(request.correlation !== undefined ? { correlation: request.correlation } : {}),
    });

    // 5. Render deterministically — coverage + photo-truth guaranteed by the renderer.
    const result = await renderComposed({
      composition,
      sections,
      photoCandidates,
      canvas,
      tagline: request.brand?.tagline ?? null,
      vocab,
      photoMode: this.deps.photoMode ?? vocab.defaultPhotoMode,
      colorTokens: request.theme.tokens.colors,
      fontFamilies: request.theme.tokens.fontFamilies,
      fontFaces: request.theme.assets.fonts,
      measure: (req) => browser.measure(req),
      ...(request.brand !== undefined ? { brand: request.brand } : {}),
    });

    // 6. Surface render warnings (board-tagged like the paint node's message style); ship the HTML.
    if (result.warnings.length > 0 && logger) {
      const boardTag = request.board
        ? `board ${request.board.index}/${request.board.total} "${request.planScreen.id}"`
        : `board "${request.planScreen.id}"`;
      for (const w of result.warnings) logger.warn(`${boardTag}: render warning: ${w}`);
    }
    return result.html;
  }
}
