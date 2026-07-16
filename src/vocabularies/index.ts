import type { ComponentVocabulary, VocabularyRegistry } from "../ports/vocabulary-registry";
import { blockframeVocabulary } from "./blockframe/index";
import { boldPosterVocabulary } from "./bold-poster/index";
import { dhabaVocabulary } from "./dhaba/index";

/** The engine's built-in theme component packages (D71). Callers may merge their own over these. */
export function builtinVocabularies(
  extra: readonly ComponentVocabulary[] = [],
): VocabularyRegistry {
  return new Map(
    [dhabaVocabulary, boldPosterVocabulary, blockframeVocabulary, ...extra].map((v) => [v.id, v]),
  );
}
