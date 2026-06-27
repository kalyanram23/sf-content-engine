/**
 * Builds a CURATED full-coverage plan (samples/plan.full.json) over every menu item, from the
 * already-regenerated samples/menu.json. Strategy:
 *   - Showcase categories (>=2 photos): grid boards (<=8 items); a gallery-fade carousel on any
 *     board whose chunk holds >=2 photo items.
 *   - Big text categories (>=5 items, <2 photos): dense list boards (<=12 items).
 *   - Small categories (<=4 items, <2 photos): packed onto shared multi-section boards (<=12
 *     items total) so we don't ship a whole screen for a single item.
 *   - Excludes obviously-non-menu items (e.g. WaterBottle).
 * Validated against thinPlanSchema; every item is covered exactly once. Run: `npm run build:full-plan`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import { canonicalItemSchema, thinPlanSchema } from "../src/domain/schemas";
import type { CanonicalItem, PlanScreen, ThinPlan } from "../src/domain/types";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const MENU = resolve(repoRoot, "samples/menu.json");
const OUT = resolve(repoRoot, "samples/plan.full.json");

const GRID = 8;
const LIST = 12;
const EXCLUDE_CATEGORIES = new Set(["WaterBottle"]);

const menu = z
  .array(canonicalItemSchema)
  .parse(JSON.parse(readFileSync(MENU, "utf8"))) as CanonicalItem[];

const hasPhoto = (i: CanonicalItem): boolean => (i.images?.length ?? 0) > 0;

function titleCase(cat: string): string {
  return cat
    .toLowerCase()
    .replace(/\s*\/\s*/g, " / ")
    .replace(/\b\w/g, (c) => c.toUpperCase())
    .replace(/\bAnd\b/g, "&");
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

// Group items by category (preserving first-seen order), excluding non-menu categories.
const byCategory = new Map<string, CanonicalItem[]>();
for (const item of menu) {
  const cat = item.category ?? "Menu";
  if (EXCLUDE_CATEGORIES.has(cat)) continue;
  const list = byCategory.get(cat) ?? [];
  list.push(item);
  byCategory.set(cat, list);
}

const screens: PlanScreen[] = [];
const smallCategories: { cat: string; items: CanonicalItem[] }[] = [];
let boardSeq = 0;
const nextId = (): string => `board-${String(++boardSeq).padStart(2, "0")}`;

for (const [cat, items] of byCategory) {
  const photos = items.filter(hasPhoto).length;
  const showcase = photos >= 2;
  const big = items.length >= 5;

  if (!showcase && !big) {
    smallCategories.push({ cat, items });
    continue;
  }

  // Photo items first so carousels + thumbnails lead each board.
  const ordered = [...items].sort((a, b) => Number(hasPhoto(b)) - Number(hasPhoto(a)));
  const rep = showcase ? ("grid" as const) : ("list" as const);
  for (const part of chunk(ordered, showcase ? GRID : LIST)) {
    const ids = part.map((i) => i.id);
    const photoIds = part.filter(hasPhoto).map((i) => i.id);
    const screen: PlanScreen = {
      id: nextId(),
      sections: [{ title: titleCase(cat), representation: rep, items: ids }],
    };
    if (photoIds.length >= 2) screen.imageSlot = { categoryId: cat, items: photoIds };
    screens.push(screen);
  }
}

// Pack small categories into shared multi-section boards (<=12 items total each).
let bucket: { cat: string; items: CanonicalItem[] }[] = [];
let bucketCount = 0;
const flushBucket = (): void => {
  if (bucket.length === 0) return;
  screens.push({
    id: nextId(),
    sections: bucket.map((b) => ({
      title: titleCase(b.cat),
      representation: "list" as const,
      items: b.items.map((i) => i.id),
    })),
  });
  bucket = [];
  bucketCount = 0;
};
for (const sc of smallCategories) {
  if (bucketCount + sc.items.length > LIST) flushBucket();
  bucket.push(sc);
  bucketCount += sc.items.length;
}
flushBucket();

const plan: ThinPlan = thinPlanSchema.parse({ screens });

// Coverage assertion: every non-excluded item appears exactly once.
const covered = new Set<string>();
for (const s of plan.screens)
  for (const sec of s.sections) for (const id of sec.items) covered.add(id);
const expected = menu.filter((i) => !EXCLUDE_CATEGORIES.has(i.category ?? "Menu"));
for (const i of expected)
  if (!covered.has(i.id)) throw new Error(`item ${i.id} (${i.name}) not covered by any board`);

writeFileSync(OUT, JSON.stringify(plan, null, 2) + "\n", "utf8");

const carousels = plan.screens.filter((s) => s.imageSlot).length;
console.warn(
  `build-full-plan: ${plan.screens.length} boards (${carousels} with carousels) covering ` +
    `${covered.size}/${menu.length} items → samples/plan.full.json ` +
    `(excluded: ${[...EXCLUDE_CATEGORIES].join(", ")}).`,
);
