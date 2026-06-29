import type { PlanLayout } from "../domain/contracts";
import type {
  CanonicalItem,
  PlanScreen,
  PlanSection,
  Representation,
  ThinPlan,
} from "../domain/types";

/**
 * Coverage planning (pure core). The LLM planner decides STRUCTURE at the category level — order,
 * grouping, representation, combined-category matrices — but never enumerates item ids. This module
 * turns that intent into a validated `ThinPlan`:
 *
 *   1. Group every menu item by category (menu order preserved).
 *   2. Expand each LLM block to the real item ids of its categories (first-wins on a category
 *      referenced twice; unknown categories ignored).
 *   3. Append any category the LLM omitted as its own section — so NOTHING is dropped.
 *   4. Pack the ordered sections into EXACTLY `screens` boards, balanced by item count via a
 *      contiguous linear partition (minimise the busiest board, keep order).
 *   5. Assert 100% coverage.
 *
 * Why deterministic: an LLM can't be trusted to enumerate 300+ ids without dropping/duplicating.
 * It does the judgment; this guarantees the bookkeeping.
 */

export interface CoverageLogger {
  warn(message: string): void;
}

const UNCATEGORIZED = "Other";

/** Items-per-board beyond which a screen reads as cramped at ~10–20 ft (advisory only). */
const LEGIBILITY_BUDGET = 24;

/** Group items by category, preserving menu order of both categories and items within them. */
function groupByCategory(items: readonly CanonicalItem[]): Map<string, CanonicalItem[]> {
  const groups = new Map<string, CanonicalItem[]>();
  for (const item of items) {
    const cat = item.category ?? UNCATEGORIZED;
    const bucket = groups.get(cat);
    if (bucket) bucket.push(item);
    else groups.set(cat, [item]);
  }
  return groups;
}

/** Fallback representation when the LLM omitted a category: dense list when big, grid when small. */
function representationForCount(count: number): Representation {
  return count > 8 ? "list" : "grid";
}

/** A section plus its item count, so we can balance boards before committing screen ids. */
interface DraftSection {
  section: PlanSection;
  size: number;
}

/** Expand the LLM blocks (+ any omitted categories) into ordered draft sections. */
function draftSections(
  layout: PlanLayout,
  byCategory: Map<string, CanonicalItem[]>,
  logger?: CoverageLogger,
): DraftSection[] {
  const used = new Set<string>();
  const drafts: DraftSection[] = [];

  for (const block of layout.blocks) {
    const cats = block.categories.filter((c) => {
      if (used.has(c)) {
        logger?.warn(`coverage: category "${c}" referenced by multiple blocks; keeping the first.`);
        return false;
      }
      return byCategory.has(c);
    });
    const items = cats.flatMap((c) => byCategory.get(c) ?? []);
    if (items.length === 0) continue; // block referenced only unknown/already-used categories
    cats.forEach((c) => used.add(c));
    const hint = block.layoutHint.trim();
    drafts.push({
      section: {
        title: block.title,
        representation: block.representation,
        items: items.map((i) => i.id),
        ...(hint !== "" ? { layoutHint: hint } : {}),
      },
      size: items.length,
    });
  }

  // Coverage net: any category the LLM forgot becomes its own section (menu order), appended.
  for (const [cat, items] of byCategory) {
    if (used.has(cat)) continue;
    logger?.warn(`coverage: category "${cat}" was not placed by the planner; appending it.`);
    used.add(cat);
    drafts.push({
      section: {
        title: cat,
        representation: representationForCount(items.length),
        items: items.map((i) => i.id),
      },
      size: items.length,
    });
  }
  return drafts;
}

/** Split a draft section's items in half (used only when boards outnumber sections). */
function splitDraft(draft: DraftSection): [DraftSection, DraftSection] {
  const ids = draft.section.items;
  const mid = Math.ceil(ids.length / 2);
  const make = (part: string[], n: number): DraftSection => ({
    section: { ...draft.section, title: `${draft.section.title} (${n})`, items: part },
    size: part.length,
  });
  return [make(ids.slice(0, mid), 1), make(ids.slice(mid), 2)];
}

/** Ensure at least `k` sections by splitting the largest ones (when boards > categories). */
function ensureAtLeast(drafts: DraftSection[], k: number): DraftSection[] {
  const out = [...drafts];
  while (out.length < k) {
    let idx = -1;
    let best = 1;
    for (let i = 0; i < out.length; i += 1) {
      const len = out[i]!.section.items.length;
      if (len > best) {
        best = len;
        idx = i;
      }
    }
    if (idx === -1) break; // nothing left to split (every section is a single item)
    const [a, b] = splitDraft(out[idx]!);
    out.splice(idx, 1, a, b);
  }
  return out;
}

/**
 * Partition `n` ordered section sizes into exactly `k` contiguous groups minimising the busiest
 * group's total — the classic linear-partition DP. Returns the section COUNT per group. Caller
 * guarantees 1 <= k <= n.
 */
export function partitionContiguous(sizes: number[], k: number): number[] {
  const n = sizes.length;
  if (k <= 1) return [n];
  if (k >= n) return sizes.map(() => 1);

  const prefix = [0];
  for (let i = 0; i < n; i += 1) prefix.push(prefix[i]! + sizes[i]!);
  const groupSum = (a: number, b: number): number => prefix[b]! - prefix[a]!; // items [a, b)

  const INF = Number.POSITIVE_INFINITY;
  const dp: number[][] = Array.from({ length: k + 1 }, () => new Array<number>(n + 1).fill(INF));
  const cut: number[][] = Array.from({ length: k + 1 }, () => new Array<number>(n + 1).fill(0));
  dp[0]![0] = 0;
  for (let j = 1; j <= k; j += 1) {
    for (let i = j; i <= n; i += 1) {
      for (let p = j - 1; p < i; p += 1) {
        const candidate = Math.max(dp[j - 1]![p]!, groupSum(p, i));
        if (candidate < dp[j]![i]!) {
          dp[j]![i] = candidate;
          cut[j]![i] = p;
        }
      }
    }
  }

  const boundaries: number[] = [n];
  let i = n;
  for (let j = k; j >= 1; j -= 1) {
    const p = cut[j]![i]!;
    boundaries.unshift(p);
    i = p;
  }
  const counts: number[] = [];
  for (let g = 0; g < k; g += 1) counts.push(boundaries[g + 1]! - boundaries[g]!);
  return counts;
}

/** Throw if any menu item failed to land on a board — the non-negotiable coverage guarantee. */
function assertCoverage(plan: ThinPlan, items: readonly CanonicalItem[]): void {
  const placed = new Set<string>();
  for (const screen of plan.screens)
    for (const section of screen.sections) for (const id of section.items) placed.add(id);
  const missing = items.filter((item) => !placed.has(item.id));
  if (missing.length > 0) {
    const sample = missing
      .slice(0, 3)
      .map((m) => m.name)
      .join(", ");
    throw new Error(
      `coverage: ${missing.length} menu item(s) not placed on any board (e.g. ${sample}).`,
    );
  }
}

/**
 * Expand a category-level {@link PlanLayout} into a full, coverage-guaranteed {@link ThinPlan} of
 * exactly `screens` boards. Pure: no IO, deterministic given the same inputs.
 */
export function expandLayoutToPlan(
  layout: PlanLayout,
  items: readonly CanonicalItem[],
  screens: number,
  logger?: CoverageLogger,
): ThinPlan {
  const byCategory = groupByCategory(items);
  let drafts = draftSections(layout, byCategory, logger);
  if (drafts.length === 0) throw new Error("coverage: layout produced no sections.");
  if (drafts.length < screens) drafts = ensureAtLeast(drafts, screens);

  const boards = Math.min(screens, drafts.length);
  if (boards < screens) {
    logger?.warn(
      `coverage: only ${drafts.length} block(s) available for ${screens} screens; using ${boards}.`,
    );
  }

  const counts = partitionContiguous(
    drafts.map((d) => d.size),
    boards,
  );
  const planScreens: PlanScreen[] = [];
  let cursor = 0;
  counts.forEach((count, i) => {
    const group = drafts.slice(cursor, cursor + count);
    cursor += count;
    planScreens.push({ id: `screen-${i + 1}`, sections: group.map((d) => d.section) });
  });

  const plan: ThinPlan = { screens: planScreens };
  assertCoverage(plan, items);

  // Warn (don't block) when a board is denser than comfortable at ~10–20 ft — "cram, don't expand".
  for (const screen of plan.screens) {
    const count = screen.sections.reduce((n, s) => n + s.items.length, 0);
    if (count > LEGIBILITY_BUDGET) {
      logger?.warn(
        `coverage: ${screen.id} has ${count} items — dense for ~10–20 ft viewing (budget ~${LEGIBILITY_BUDGET}); raise --screens for more breathing room.`,
      );
    }
  }
  return plan;
}

/* ------------------------------------------------------------------ menu digest for the planner */

/** One category's compact summary for the planner prompt (no ids — the LLM works by name). */
export interface CategoryDigest {
  category: string;
  count: number;
  withPhotos: number;
  /** A few representative item names so the LLM can spot shared-base structure (e.g. Biryani/Pulav). */
  sampleNames: string[];
}

/** Summarise the menu by category for the LLM planner — small, id-free, menu order preserved. */
export function buildMenuDigest(
  items: readonly CanonicalItem[],
  samplesPerCategory = 8,
): CategoryDigest[] {
  const byCategory = groupByCategory(items);
  const digest: CategoryDigest[] = [];
  for (const [category, catItems] of byCategory) {
    digest.push({
      category,
      count: catItems.length,
      withPhotos: catItems.filter((i) => (i.images?.length ?? 0) > 0).length,
      sampleNames: catItems.slice(0, samplesPerCategory).map((i) => i.name),
    });
  }
  return digest;
}
