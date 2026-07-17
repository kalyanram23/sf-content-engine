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
 * Digest price for one item: per-size prices (`S $5.00 / M $7.00`) when the item is priced per size,
 * else its flat/market price. Keeps the composer LLM looking at real prices instead of "MP".
 */
const sizedMoney = (it: Pick<VocabItem, "price" | "sizes">): string =>
  it.sizes !== undefined && it.sizes.length > 0
    ? it.sizes.map((s) => `${s.label} ${money(s.price)}`).join(" / ")
    : money(it.price);

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
    ...(it.sizes !== undefined && it.sizes.length > 0 ? { sizes: it.sizes } : {}),
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

  // Photo candidates: the UNION of the board-level imageSlot ids AND every per-section imageSlot's
  // ids, each ∩ items that actually carry a photo. Board-level items stay UNTAGGED (`slot` undefined —
  // the band root's data-image-slot="shared" satisfies them); a per-section slot's items are TAGGED
  // with the section title (the marker `checkImageSlots` keys on), so the shared band can stamp
  // data-image-slot="<title>" per card and each per-section slot is verifiable inside one band.
  // De-duped by id: the board-level slot wins, then the first section in plan order (keep first).
  const photoCandidates: VocabItem[] = [];
  const seenPhoto = new Set<string>();
  const addCandidate = (id: string, slot: string | undefined): void => {
    if (seenPhoto.has(id)) return;
    const it = byId.get(id);
    if (it === undefined || !hasImage(it)) return;
    seenPhoto.add(id);
    photoCandidates.push({ ...toVocabItem(it), ...(slot !== undefined ? { slot } : {}) });
  };
  for (const id of planScreen.imageSlot?.items ?? []) addCandidate(id, undefined);
  for (const section of planScreen.sections) {
    if (section.imageSlot === undefined) continue;
    for (const id of section.imageSlot.items) addCandidate(id, section.title);
  }

  const secLines = sections
    .map(
      (s) =>
        `Section "${s.title}" (${s.items.length}): ` +
        s.items.map((it) => `${it.name} ${sizedMoney(it)}`).join("; "),
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
