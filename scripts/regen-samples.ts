/**
 * Regenerates samples/menu.json (the full menu, WITH item photos) and samples/plan.json (a
 * 3-board batch) from samples/menu_simple.json. Deterministic and validated against the real
 * schemas so the batch can't ship a broken plan (full UUIDs, exact category strings, every
 * image-slot item actually has a photo). Run: `npm run regen:samples`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import { canonicalItemSchema, thinPlanSchema } from "../src/domain/schemas";
import type { CanonicalItem, ThinPlan } from "../src/domain/types";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SRC = resolve(repoRoot, "samples/menu_simple.json");
const MENU_OUT = resolve(repoRoot, "samples/menu.json");
const PLAN_OUT = resolve(repoRoot, "samples/plan.json");

interface SourceItem {
  id: string;
  name: string;
  price: number | null;
  image: string | null;
  category: string | null;
}

/** The 3-board batch: photo-rich categories, in descending photo coverage. */
const BOARDS: { id: string; title: string; category: string }[] = [
  { id: "screen-1", title: "Indo-Chinese", category: "INDO - CHINESE" },
  { id: "screen-2", title: "Non-Veg Appetizers", category: "NON VEG APPETIZERS" },
  { id: "screen-3", title: "Chaats", category: "CHATS" },
];

const GRID_CAPACITY = 8;

function buildMenu(source: SourceItem[]): CanonicalItem[] {
  return source.map((s) => {
    const draft: Record<string, unknown> = { id: s.id, name: s.name };
    if (typeof s.price === "number") draft["price"] = s.price;
    if (typeof s.category === "string" && s.category) draft["category"] = s.category;
    if (typeof s.image === "string" && s.image) draft["images"] = [s.image];
    return canonicalItemSchema.parse(draft);
  });
}

function buildPlan(menu: CanonicalItem[]): ThinPlan {
  const screens = BOARDS.map((board) => {
    const photoItems = menu
      .filter((i) => i.category === board.category && (i.images?.length ?? 0) > 0)
      .slice(0, GRID_CAPACITY);
    if (photoItems.length < 2) {
      throw new Error(`category "${board.category}" has <2 photo items — bad batch choice`);
    }
    const ids = photoItems.map((i) => i.id);
    return {
      id: board.id,
      imageSlot: { categoryId: board.category, items: ids },
      sections: [{ title: board.title, representation: "grid" as const, items: ids }],
    };
  });
  return thinPlanSchema.parse({ screens });
}

function assertPlanResolves(plan: ThinPlan, menu: CanonicalItem[]): void {
  const byId = new Map(menu.map((i) => [i.id, i]));
  for (const screen of plan.screens) {
    for (const section of screen.sections)
      for (const id of section.items)
        if (!byId.has(id)) throw new Error(`plan ${screen.id} section item ${id} not in menu`);
    for (const id of screen.imageSlot?.items ?? []) {
      const item = byId.get(id);
      if (!item) throw new Error(`plan ${screen.id} imageSlot item ${id} not in menu`);
      if ((item.images?.length ?? 0) === 0)
        throw new Error(`plan ${screen.id} imageSlot item ${id} has no photo (blank slide)`);
    }
  }
}

const source = z.array(z.any()).parse(JSON.parse(readFileSync(SRC, "utf8"))) as SourceItem[];
const menu = buildMenu(source);
const plan = buildPlan(menu);
assertPlanResolves(plan, menu);

writeFileSync(MENU_OUT, JSON.stringify(menu, null, 2) + "\n", "utf8");
writeFileSync(PLAN_OUT, JSON.stringify(plan, null, 2) + "\n", "utf8");

const withPhotos = menu.filter((i) => (i.images?.length ?? 0) > 0).length;
console.warn(
  `regen-samples: wrote ${menu.length} items (${withPhotos} with photos) → samples/menu.json; ` +
    `${plan.screens.length}-board plan → samples/plan.json ` +
    `[${plan.screens.map((s) => `${s.sections[0]?.title}:${s.sections[0]?.items.length}`).join(", ")}].`,
);
