import type { PlanLayout } from "../domain/contracts";
import type {
  CanonicalItem,
  PlanImageSlot,
  PlanScreen,
  PlanSection,
  Representation,
  SectionMatrix,
  ThinPlan,
} from "../domain/types";
import { isMatrixBoard } from "./layout-strategy";
import { buildMatrix } from "./matrix";
import { type Canvas, DEFAULT_PACKED_MULTIPLIER, densityTier, maxRowsForCanvas } from "./sizing";

/**
 * Coverage planning (pure core). The LLM planner decides STRUCTURE at the category level — order,
 * grouping, representation, combined-category matrices — but never enumerates item ids. This module
 * turns that intent into a validated `ThinPlan`:
 *
 *   1. Group every menu item by category (menu order preserved).
 *   2. Expand each LLM block to the real item ids of its categories (first-wins on a category
 *      referenced twice; unknown categories ignored).
 *   3. Append any category the LLM omitted as its own section — so NOTHING is dropped.
 *   4. Pack the ordered sections into the boards, balanced by weight via a contiguous linear
 *      partition (minimise the busiest board, keep order). Sections are ATOMIC (D25): a category
 *      never splits across screens, so the board count caps at the section count.
 *   5. Assert 100% coverage.
 *
 * Why deterministic: an LLM can't be trusted to enumerate 300+ ids without dropping/duplicating.
 * It does the judgment; this guarantees the bookkeeping.
 */

export interface CoverageLogger {
  warn(message: string): void;
}

/** How the requested screen count is honoured (D26): `"exact"` — the count is law (capped only by
 * the section count, D25 atomicity); `"elastic"` (default) — a hint the fit arithmetic may raise
 * to fit the budget or lower when boards would be sparse. */
export type ScreensMode = "exact" | "elastic";

/**
 * Options controlling the fit (§ Phase 3 / D25 / D26). `legibilityBudget`, `minItemsPerBoard` and
 * `screensMode` come from `config.planning`; `canvas`, when supplied, tightens the per-board budget
 * to what the canvas can actually hold via the sizing ladder (`maxRowsForCanvas`). All optional so
 * the pure function keeps its simple defaults for unit tests.
 */
export interface ExpandOptions {
  legibilityBudget?: number;
  minItemsPerBoard?: number;
  screensMode?: ScreensMode;
  /** Multiplier splitting the `dense`/`packed` density tiers (D30); mirrors `planning.packedMultiplier`. */
  packedMultiplier?: number;
  canvas?: Canvas;
  logger?: CoverageLogger;
}

const UNCATEGORIZED = "Other";

/** Default items/rows per board when no config is threaded (mirrors `planning.legibilityBudget`). */
const DEFAULT_LEGIBILITY_BUDGET = 24;
/** Default sparse floor (mirrors `planning.minItemsPerBoard`). */
const DEFAULT_MIN_ITEMS_PER_BOARD = 4;

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

/** A section plus its packing WEIGHT, so we can balance boards before committing screen ids. The
 * weight is the matrix ROW count for a matrix section (paired items share a line) else item count. */
interface DraftSection {
  section: PlanSection;
  size: number;
}

/** The packing weight of a section: matrix rows (paired items share a line) or plain item count. */
function sectionWeight(section: PlanSection): number {
  return section.matrix ? section.matrix.rows.length : section.items.length;
}

/**
 * A per-item size/price matrix (single sized/variant category, e.g. pizza 8″/10″/12″) is NOT a
 * cross-category base-dish comparison — the representation oracle handles it. Guard against building
 * a nonsensical single-column base-dish table for it.
 */
function isPerItemSizeMatrix(cats: readonly string[], items: readonly CanonicalItem[]): boolean {
  return (
    cats.length === 1 &&
    items.length > 0 &&
    items.every((i) => (i.sizes?.length ?? 0) > 0 || (i.variants?.length ?? 0) > 0)
  );
}

/**
 * Compute the cross-category comparison matrix for a block when it warrants one: a combined block
 * (>1 category) OR an explicit `matrix` representation (§ Phase 1). Skips the per-item size-matrix
 * case. `cats` are the resolved, present category names (matrix columns).
 */
function matrixForBlock(
  cats: string[],
  representation: Representation,
  byCategory: Map<string, CanonicalItem[]>,
): SectionMatrix | undefined {
  const items = cats.flatMap((c) => byCategory.get(c) ?? []);
  if (!(cats.length > 1 || representation === "matrix")) return undefined;
  if (isPerItemSizeMatrix(cats, items)) return undefined;
  const subMap = new Map(cats.map((c) => [c, byCategory.get(c) ?? []]));
  return buildMatrix(cats, subMap);
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
    const matrix = matrixForBlock(cats, block.representation, byCategory);
    const section: PlanSection = {
      title: block.title,
      representation: block.representation,
      items: items.map((i) => i.id),
      ...(hint !== "" ? { layoutHint: hint } : {}),
      ...(matrix !== undefined ? { matrix } : {}),
    };
    drafts.push({ section, size: sectionWeight(section) });
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

/** Photo carousel slots hold a handful of photos — enough to rotate, small enough to stay a hero. */
const IMAGE_SLOT_MAX_PHOTOS = 6;

/**
 * Synthesize a board-level photo-carousel slot for a MATRIX board. The matrix layout strategy
 * asks the painter for ONE shared rotating hero, but only a hand-authored plan ever carried the
 * `imageSlot` naming which photos to cycle — the LLM-planner path had no way to reach the
 * carousel. Grid boards are deliberately excluded: their per-section heroes already come from
 * the layout strategy, and a board-level slot on top would double the hero.
 */
function synthesizeImageSlot(
  sections: readonly PlanSection[],
  byId: Map<string, CanonicalItem>,
): PlanImageSlot | undefined {
  // Same matrix test the blueprint selector + painter use (representation OR layoutHint), so a
  // layoutHint-only table board still gets its shared-hero carousel.
  if (!isMatrixBoard({ sections })) return undefined;
  const photoIds: string[] = [];
  for (const section of sections) {
    for (const id of section.items) {
      const item = byId.get(id);
      if ((item?.images?.length ?? 0) > 0 && !photoIds.includes(id)) photoIds.push(id);
      if (photoIds.length >= IMAGE_SLOT_MAX_PHOTOS) break;
    }
    if (photoIds.length >= IMAGE_SLOT_MAX_PHOTOS) break;
  }
  // A carousel needs at least two photos to rotate; below that the painter's own hero handling wins.
  return photoIds.length >= 2 ? { items: photoIds } : undefined;
}

/**
 * A category-anchored photo panel for a COMFORTABLE, non-matrix board with clear spare canvas (D33).
 * A sparse board's failure mode is dead space, and the product rule is: small menu + empty space →
 * fill it with food photography, not decoration. So when the planner left a comfortable board with
 * room to spare and some of its items carry photos, guarantee an `imageSlot` exists (the painter's
 * sparse register then absorbs the empty canvas with it). Labelled with the DOMINANT category (the
 * one owning the most of the slot's photos) so the painter captions + anchors it to that section
 * rather than floating a hero. Unlike the matrix shared hero this fires for a SINGLE photo too (a
 * static panel still sells the food + fills the space). Returns undefined when no item has a photo.
 */
function comfortableImageSlot(
  sections: readonly PlanSection[],
  byId: Map<string, CanonicalItem>,
): PlanImageSlot | undefined {
  const photoIds: string[] = [];
  const catCounts = new Map<string, number>();
  for (const section of sections) {
    for (const id of section.items) {
      const item = byId.get(id);
      if ((item?.images?.length ?? 0) > 0 && !photoIds.includes(id)) {
        photoIds.push(id);
        if (item?.category !== undefined)
          catCounts.set(item.category, (catCounts.get(item.category) ?? 0) + 1);
      }
      if (photoIds.length >= IMAGE_SLOT_MAX_PHOTOS) break;
    }
    if (photoIds.length >= IMAGE_SLOT_MAX_PHOTOS) break;
  }
  if (photoIds.length === 0) return undefined;
  // Dominant category (first-wins on a tie, thanks to Map insertion order + strict >).
  let categoryId: string | undefined;
  let best = 0;
  for (const [cat, count] of catCounts) {
    if (count > best) {
      best = count;
      categoryId = cat;
    }
  }
  return { ...(categoryId !== undefined ? { categoryId } : {}), items: photoIds };
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
 * The per-board fit budget in rows/items: the config `legibilityBudget`, tightened to what the
 * target canvas actually holds (`maxRowsForCanvas`) when a canvas is supplied. Both the elastic
 * board-count arithmetic AND matrix-row splitting use this ONE number, so they never disagree.
 */
function effectiveBudget(legibilityBudget: number, canvas?: Canvas): number {
  const fromCanvas = canvas !== undefined ? maxRowsForCanvas(canvas) : Number.POSITIVE_INFINITY;
  return Math.max(1, Math.min(legibilityBudget, fromCanvas));
}

/**
 * Elastic board count (§ Phase 3): the requested `hint` is treated as a target, not a hard count.
 * RAISE to the arithmetic minimum when the content can't fit (`totalWeight` over `budget`/board),
 * and LOWER toward that minimum when the request would leave boards below `minItems` each (dead
 * space) — never below 1. Every adjustment is logged with the numbers that drove it.
 */
function elasticBoards(
  hint: number,
  totalWeight: number,
  totalItems: number,
  budget: number,
  minItems: number,
  logger?: CoverageLogger,
): number {
  let boards = Math.max(1, hint);
  const minBoards = Math.max(1, Math.ceil(totalWeight / budget));
  if (boards < minBoards) {
    logger?.warn(
      `coverage: ${totalWeight} row/item weight over ${boards} board(s) exceeds the ~${budget}/board budget; raising to ${minBoards} board(s).`,
    );
    boards = minBoards;
  }
  // Sparse cap: the most boards that keep ≥ minItems items each, but never below the fit minimum.
  const sparseCap = Math.max(minBoards, Math.floor(totalItems / minItems), 1);
  if (boards > sparseCap) {
    logger?.warn(
      `coverage: ${boards} board(s) would leave boards under ~${minItems} items each (${totalItems} items); lowering to ${sparseCap} board(s).`,
    );
    boards = sparseCap;
  }
  return Math.max(1, boards);
}

/**
 * Expand a category-level {@link PlanLayout} into a full, coverage-guaranteed {@link ThinPlan}.
 * In `"elastic"` mode (default) `screens` is a HINT (§ Phase 3): the board count flexes to fit the
 * menu against the per-board budget and a sparse floor. In `"exact"` mode (D26) `screens` is law.
 * Under BOTH modes sections are atomic (D25): a category never splits across screens, so the board
 * count caps at the section count. Pure: no IO, deterministic given the same inputs.
 */
export function expandLayoutToPlan(
  layout: PlanLayout,
  items: readonly CanonicalItem[],
  screens: number,
  options: ExpandOptions = {},
): ThinPlan {
  const logger = options.logger;
  const budget = effectiveBudget(
    options.legibilityBudget ?? DEFAULT_LEGIBILITY_BUDGET,
    options.canvas,
  );
  const minItems = options.minItemsPerBoard ?? DEFAULT_MIN_ITEMS_PER_BOARD;
  const mode: ScreensMode = options.screensMode ?? "elastic";
  const packedMultiplier = options.packedMultiplier ?? DEFAULT_PACKED_MULTIPLIER;

  const byCategory = groupByCategory(items);
  const drafts = draftSections(layout, byCategory, logger);
  if (drafts.length === 0) throw new Error("coverage: layout produced no sections.");

  const totalWeight = drafts.reduce((n, d) => n + d.size, 0);
  const totalItems = items.length;
  let boards =
    mode === "exact"
      ? Math.max(1, screens)
      : elasticBoards(screens, totalWeight, totalItems, budget, minItems, logger);

  // Categories are ATOMIC (D25): a section never splits across boards, so the board count can
  // never exceed the section count — cap it (with the numbers) when that lowers the request.
  if (boards > drafts.length) {
    logger?.warn(
      `coverage: ${boards} board(s) ${mode === "exact" ? "requested" : "targeted"} but the menu has only ` +
        `${drafts.length} section(s) — categories are atomic (never split across screens, D25); ` +
        `lowering to ${drafts.length} board(s).`,
    );
    boards = drafts.length;
  }

  const counts = partitionContiguous(
    drafts.map((d) => d.size),
    boards,
  );
  const byId = new Map(items.map((item) => [item.id, item]));
  const planScreens: PlanScreen[] = [];
  let cursor = 0;
  counts.forEach((count, i) => {
    const group = drafts.slice(cursor, cursor + count);
    cursor += count;
    const sections = group.map((d) => d.section);
    // Stamp the deterministic density tier (D30) from this board's row/item weight against the same
    // per-canvas `budget` the fit arithmetic used, so the painter idiom + critic register + QA
    // grading all key off ONE classification. Hand-authored plans (StaticPlanner) carry no tier;
    // their consumers recompute it identically (shared `densityTier` arithmetic).
    const weight = group.reduce((n, d) => n + d.size, 0);
    const tier = densityTier(weight, budget, packedMultiplier);
    // Image slot: the matrix shared hero (any tier, its own ≥2-photo rule) OR — when a COMFORTABLE,
    // non-matrix board has clear spare canvas (rows well under budget) and photo-bearing items — a
    // category-anchored photo panel to absorb the empty space (D33). Deterministic + conservative:
    // only when the matrix synthesis didn't already supply a slot, and NEVER on dense/packed boards
    // (they suppress photos, D30) or a board that is already comfortably full.
    const imageSlot =
      synthesizeImageSlot(sections, byId) ??
      (tier === "comfortable" && !isMatrixBoard({ sections }) && weight * 2 <= budget
        ? comfortableImageSlot(sections, byId)
        : undefined);
    planScreens.push({
      id: `screen-${i + 1}`,
      sections,
      densityTier: tier,
      ...(imageSlot !== undefined ? { imageSlot } : {}),
    });
  });

  const plan: ThinPlan = { screens: planScreens };
  assertCoverage(plan, items);

  // Dense-board warning: a board over the budget is now the INTENDED signal for an oversized
  // (atomic, D25) category — or an exact-mode count below the fit minimum. It renders dense on one
  // screen in the tier-appropriate compact idiom (D30) / over-budget sizing regime (D26); warn,
  // never split or block. The stamped tier drives the painter/critic/QA downstream.
  for (const screen of plan.screens) {
    if (screen.densityTier === "comfortable") continue;
    const weight = screen.sections.reduce((n, s) => n + sectionWeight(s), 0);
    logger?.warn(
      `coverage: ${screen.id} carries ${weight} rows/items (${screen.densityTier}) — dense for ~10–20 ft viewing (budget ~${budget}).`,
    );
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
