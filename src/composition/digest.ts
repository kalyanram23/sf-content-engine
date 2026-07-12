/**
 * Digest builder — turns a plan screen + its canonical items into the compact, id-free CONTENT
 * DIGEST the composer LLM judges over, plus the VOCABULARY PROMPT block (the engine's three abstract
 * block kinds, described in the theme's own voice via its {@link ComponentVocabulary.promptNotes}).
 *
 * Ported from the validated prototype `prototypes/component-vocab/compose.ts` (`selectContent`'s
 * digest + `buildSystem`'s block-vocabulary paragraph), adapted to the engine's domain:
 *   - content comes from the PLAN (sections + imageSlot), not a raw-menu category slice;
 *   - the block kinds are the engine's `section` / `group` / `photoBand` (the prototype's
 *     section / triBand / collage), described through the injected vocabulary's promptNotes so the
 *     composer composes in the theme's voice without ever seeing HTML.
 *
 * Pure: no IO, no clock, no randomness.
 */

import type { CanonicalItem, PlanScreen } from "../domain/types";
import type { ComponentVocabulary, VocabItem, VocabSection } from "../ports/vocabulary-registry";

export interface ComposerContent {
  sections: VocabSection[];
  photoCandidates: VocabItem[];
  /** Section/item lines + photo library — the prototype `selectContent` digest format. */
  digest: string;
  /** Block-kind contract + the vocabulary's per-kind promptNotes. */
  vocabularyPrompt: string;
}

/** Strip a trailing annotation marker (a menu " *") — a clean of source data, not invented copy. */
const cleanName = (s: string): string => s.replace(/\s*\*+\s*$/, "").trim();

/** Price display for the digest: a market-price (null) item shows "MP", else "$0.00". */
const money = (price: number | null): string => (price === null ? "MP" : `$${price.toFixed(2)}`);

/**
 * Build the composer's content: resolve the plan screen's sections + photo slot against the
 * canonical items, then render the digest + vocabulary-prompt strings.
 */
export function buildComposerContent(args: {
  planScreen: PlanScreen;
  items: CanonicalItem[];
  vocab: ComponentVocabulary;
}): ComposerContent {
  const { planScreen, items, vocab } = args;
  const byId = new Map(items.map((it) => [it.id, it]));

  const hasImage = (it: CanonicalItem): boolean => (it.images?.length ?? 0) > 0;
  const toVocabItem = (it: CanonicalItem): VocabItem => ({
    id: it.id,
    name: cleanName(it.name),
    price: it.price ?? null,
    hasImage: hasImage(it),
  });

  // Sections: each plan section's item ids joined to the canonical items (unknown ids skipped).
  const sections: VocabSection[] = planScreen.sections.map((section) => ({
    title: section.title,
    items: section.items
      .map((id) => byId.get(id))
      .filter((it): it is CanonicalItem => it !== undefined)
      .map(toVocabItem),
  }));

  // Photo candidates: the board's imageSlot ids ∩ items that actually carry a photo.
  const photoCandidates: VocabItem[] = (planScreen.imageSlot?.items ?? [])
    .map((id) => byId.get(id))
    .filter((it): it is CanonicalItem => it !== undefined && hasImage(it))
    .map(toVocabItem);

  const secLines = sections
    .map(
      (s) =>
        `Section "${s.title}" (${s.items.length}): ` +
        s.items.map((it) => `${it.name} ${money(it.price)}`).join("; "),
    )
    .join("\n");
  const photoLines = photoCandidates.map((c) => `  ${c.id} = ${c.name}`).join("\n");
  const digest =
    `BOARD CONTENT — render every section below exactly once:\n${secLines}\n\n` +
    `PHOTO LIBRARY — the only ids you may put in a collage:\n${photoLines}`;

  const notes = vocab.promptNotes;
  const vocabularyPrompt =
    `Block vocabulary (each block's "kind" + the ONE field it uses):\n` +
    `- "section" → { "kind":"section", "section":"<exact section title>" } — ${notes.section}\n` +
    `- "group" → { "kind":"group", "sections":["<title>","<title>",...] } — ${notes.group}\n` +
    `- "photoBand" → { "kind":"photoBand", "itemIds":["<id>",...] } — ${notes.photoBand}\n` +
    `Every section must appear exactly once (as a "section" or inside a "group"). ` +
    `Pick photoBand ids ONLY from the photo library.`;

  return { sections, photoCandidates, digest, vocabularyPrompt };
}
