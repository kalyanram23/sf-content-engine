import type { ComponentVocabulary, VocabularyRegistry } from "../ports/vocabulary-registry";
import { bazaarVocabulary } from "./bazaar/index";
import { blockframeVocabulary } from "./blockframe/index";
import { boldPosterVocabulary } from "./bold-poster/index";
import { bubblegumVocabulary } from "./bubblegum/index";
import { dhabaVocabulary } from "./dhaba/index";

/** The engine's built-in theme component packages (D71). Callers may merge their own over these. */
export function builtinVocabularies(
  extra: readonly ComponentVocabulary[] = [],
): VocabularyRegistry {
  return new Map(
    [
      dhabaVocabulary,
      boldPosterVocabulary,
      blockframeVocabulary,
      bazaarVocabulary,
      bubblegumVocabulary,
      ...extra,
    ].map((v) => [v.id, v]),
  );
}
