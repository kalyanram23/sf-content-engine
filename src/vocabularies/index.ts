import type { ComponentVocabulary, VocabularyRegistry } from "../ports/vocabulary-registry";
import { dhabaVocabulary } from "./dhaba/index";

/** The engine's built-in theme component packages (D71). Callers may merge their own over these. */
export function builtinVocabularies(
  extra: readonly ComponentVocabulary[] = [],
): VocabularyRegistry {
  return new Map([dhabaVocabulary, ...extra].map((v) => [v.id, v]));
}
