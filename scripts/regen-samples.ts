/**
 * Regenerates samples/menu.json (the engine-shaped CanonicalItem[]) and samples/plan.json (a
 * "bubblegum" batch) from samples/menu_simple.json — a RAW TOAST POS EXPORT (nested
 * `menus → menuGroups → menuItems`, with one duplicate copy per delivery platform) — filtered by
 * the out-of-stock list in samples/inventory.json. We:
 *
 *   1. Walk every menuGroup recursively and collect (groupName, item).
 *   2. Drop items the inventory marks OUT_OF_STOCK (matched by Toast guid / multiLocationId,
 *      decided per dish NAME so an in-stock copy on any platform keeps the dish). See
 *      `outOfStockNames`. Untracked dishes (no inventory record) are kept.
 *   3. Dedup by normalized item NAME — the same dish recurs under Main Menu / "(GH)" copies with
 *      different guids, so guid/masterId are unreliable keys — preferring a copy that carries a
 *      photo and a price.
 *   4. Normalize the export's shouty group names ("BIRYANIS" → "Biryani", "INDO - CHINESE" →
 *      "Indo Chinese"); see CATEGORY_ALIASES + the title-case fallback.
 *   5. Emit CanonicalItem[] with short, logical ids (a letter per category in first-appearance
 *      order + a 1-based index: a1, a2 … b1 …) — far cheaper in the painter prompt than the
 *      36-char Toast guid, which we now use only to dedup / skip junk rows.
 *   6. Author a best-effort plan: a combined BIRYANI & PULAV grid (matched dish pairs) plus
 *      photo-rich category grids — each board is skipped when the (post-inventory) menu has too
 *      few photos to fill it, so the board count adapts to the batch instead of throwing.
 *
 * The menu is written before the plan so the primary fixture regenerates even for a thin batch.
 * Run: `npm run regen:samples`.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { canonicalItemSchema, thinPlanSchema } from "../src/domain/schemas";
import type { CanonicalItem, ThinPlan } from "../src/domain/types";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const SRC = resolve(repoRoot, "samples/menu_simple.json");
const INVENTORY = resolve(repoRoot, "samples/inventory.json");
const MENU_OUT = resolve(repoRoot, "samples/menu.json");
const PLAN_OUT = resolve(repoRoot, "samples/plan.json");

const GRID_CAPACITY = 8;

/* ----------------------------------------------------------------- raw Toast export shapes */
interface ToastItem {
  name?: string;
  guid?: string;
  multiLocationId?: string | number;
  price?: number | null;
  image?: string | null;
}
interface ToastGroup {
  name?: string;
  menuItems?: ToastItem[];
  menuGroups?: ToastGroup[];
}
interface ToastExport {
  menus?: { menuGroups?: ToastGroup[] }[];
}

/**
 * Collapse the export's UPPERCASE / punctuated / misspelt group names into clean category labels.
 * The Toast export groups dishes under names like "BIRYANIS" / "INDO - CHINESE" / "VEG CURRIES";
 * the plan boards below key on the clean labels ("Biryani", "Indo Chinese", …), so the critical
 * ones MUST normalize exactly. Anything all-caps not listed here is title-cased by the fallback.
 */
const CATEGORY_ALIASES: Record<string, string> = {
  // critical — referenced by the plan boards, must match exactly
  BIRYANIS: "Biryani",
  PULAVS: "Pulav",
  "VEG CURRIES": "Veg Curries",
  "NON VEG CURRIES": "Non Veg Curries",
  "VEG APPETIZERS": "Veg Appetizers",
  "NON VEG APPETIZERS": "Non Veg Appetizers",
  "INDO - CHINESE": "Indo Chinese",
  // cosmetic — keep the long tail of menu.json labels tidy
  "MANDI HOUSE": "Mandi",
  "TANDOORI (KEBABS)": "Tandoori / Kebab",
  "NAANS / BREADS": "Naans / Breads",
  "SPECIAL RICE": "Special Rice",
  "DRINKS (COLD) / BEVERAGES": "Cold Drinks / Beverages",
  "DRINKS (HOT)": "Hot Drinks",
  CHATS: "Chaat",
  "Muntha Masala *": "Muntha Masala",
  "Coconut rice specials": "Coconut Rice Specials",
  TIFFINS_UNTIL_2PM: "Tiffins",
  WaterBottle: "Water Bottle",
};
/** Title-case an ALL-CAPS group name ("BURGERS" → "Burgers", "QUICK BITES" → "Quick Bites"). */
function titleCase(s: string): string {
  return s.toLowerCase().replace(/\b\w/g, (m) => m.toUpperCase());
}
function normalizeCategory(raw: string | undefined): string {
  const c = (raw ?? "Menu").trim().replace(/’/g, "'");
  const alias = CATEGORY_ALIASES[c];
  if (alias !== undefined) return alias;
  // No explicit alias: tidy any remaining shouty all-caps label; leave mixed-case names as-is.
  return /[a-z]/.test(c) ? c : titleCase(c);
}

function* walkItems(groups: ToastGroup[] | undefined): Generator<[string, ToastItem]> {
  for (const g of groups ?? []) {
    for (const it of g.menuItems ?? []) yield [g.name ?? "Menu", it];
    if (g.menuGroups?.length) yield* walkItems(g.menuGroups);
  }
}

/* ----------------------------------------------------------------- inventory / stock status */
interface InventoryRecord {
  guid?: string;
  multiLocationId?: string | number;
  status?: string;
  quantity?: number | null;
}
/** An inventory record is "out of stock" when the POS says so, or quantity has dropped to ≤ 0. */
function isOutOfStock(r: InventoryRecord): boolean {
  if (r.status === "OUT_OF_STOCK") return true;
  return typeof r.quantity === "number" && r.quantity <= 0;
}

/**
 * Compute the set of normalized item names to drop as out of stock. Inventory records key on the
 * Toast `guid` / `multiLocationId`, but the same dish recurs across platform copies under different
 * guids, so we resolve every copy's stock status and decide per NAME: a dish is dropped only when
 * some copy is out of stock and NO copy is in stock (an explicit in-stock copy always wins). Names
 * with no matching inventory record at all are untracked → kept.
 */
function outOfStockNames(raw: ToastExport, inventory: InventoryRecord[]): Set<string> {
  const statusByKey = new Map<string, boolean>(); // guid|mlid → isOutOfStock
  for (const r of inventory) {
    const oos = isOutOfStock(r);
    if (r.guid) statusByKey.set(r.guid, oos);
    if (r.multiLocationId != null) statusByKey.set(String(r.multiLocationId), oos);
  }
  const hasOOS = new Set<string>();
  const hasInStock = new Set<string>();
  for (const menu of raw.menus ?? []) {
    for (const [, it] of walkItems(menu.menuGroups)) {
      const name = (it.name ?? "").trim().toLowerCase();
      if (!name) continue;
      const status =
        (it.guid !== undefined ? statusByKey.get(it.guid) : undefined) ??
        (it.multiLocationId !== undefined
          ? statusByKey.get(String(it.multiLocationId))
          : undefined);
      if (status === undefined) continue;
      (status ? hasOOS : hasInStock).add(name);
    }
  }
  const drop = new Set<string>();
  for (const name of hasOOS) if (!hasInStock.has(name)) drop.add(name);
  return drop;
}

interface Draft {
  name: string;
  category: string;
  price?: number;
  image?: string;
}

/** Bijective base-26 category code: 0→a, 1→b … 25→z, 26→aa, 27→ab … (one per category). */
function categoryCode(index: number): string {
  let n = index + 1;
  let code = "";
  while (n > 0) {
    n -= 1;
    code = String.fromCharCode(97 + (n % 26)) + code;
    n = Math.floor(n / 26);
  }
  return code;
}

function buildMenu(raw: ToastExport, dropNames: Set<string>): CanonicalItem[] {
  const byName = new Map<string, Draft>();
  let skippedNoGuid = 0;
  const droppedOutOfStock = new Set<string>();
  for (const menu of raw.menus ?? []) {
    for (const [groupName, it] of walkItems(menu.menuGroups)) {
      const name = (it.name ?? "").trim();
      const guid = it.guid ?? "";
      if (!name) continue;
      if (guid.length !== 36) {
        skippedNoGuid += 1;
        continue; // a real Toast item always carries a 36-char guid; drop modifier / junk rows
      }
      const key = name.toLowerCase();
      if (dropNames.has(key)) {
        droppedOutOfStock.add(key); // count each dropped dish once, even across platform copies
        continue; // out of stock per inventory — never put it on a screen
      }
      const existing = byName.get(key);
      if (!existing) {
        byName.set(key, {
          name,
          category: normalizeCategory(groupName),
          ...(typeof it.price === "number" ? { price: it.price } : {}),
          ...(it.image ? { image: it.image } : {}),
        });
        continue;
      }
      // Merge: a later platform copy may carry the photo / price the first one lacked.
      if (existing.price === undefined && typeof it.price === "number") existing.price = it.price;
      if (existing.image === undefined && it.image) existing.image = it.image;
    }
  }
  if (skippedNoGuid > 0) {
    console.warn(`regen-samples: skipped ${skippedNoGuid} row(s) without a 36-char guid.`);
  }
  if (droppedOutOfStock.size > 0) {
    console.warn(
      `regen-samples: dropped ${droppedOutOfStock.size} out-of-stock dish(es) per inventory.`,
    );
  }
  // Assign short ids: a letter per category (first-appearance order) + a 1-based index — a1, a2 …
  // then b1 … The Toast guid (d.id) is dropped; it only served to dedup / skip junk rows above.
  const catCode = new Map<string, string>();
  const catCount = new Map<string, number>();
  return [...byName.values()].map((d) => {
    let code = catCode.get(d.category);
    if (code === undefined) {
      code = categoryCode(catCode.size);
      catCode.set(d.category, code);
    }
    const n = (catCount.get(d.category) ?? 0) + 1;
    catCount.set(d.category, n);
    return canonicalItemSchema.parse({
      id: `${code}${n}`,
      name: d.name,
      category: d.category,
      ...(d.price !== undefined ? { price: d.price } : {}),
      ...(d.image !== undefined ? { images: [d.image] } : {}),
    });
  });
}

/* ------------------------------------------------------------------------- plan authoring */
const hasPhoto = (i: CanonicalItem): boolean => (i.images?.length ?? 0) > 0;

/** Strip the "biryani/pulav" word + noise so "Paneer Biryani" pairs with "Paneer Pulav". */
function dishBase(name: string): string {
  return name
    .toLowerCase()
    .replace(/\b(biryani|briyani|pulav)\b/g, " ")
    .replace(/\bbon+e?\s*less\b/g, " ")
    .replace(/[*()]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Dishes to feature first in the combined grid, so the board spans chicken/veg/goat/egg. */
const FEATURED_DISHES = ["chicken fry piece", "paneer", "goat kheema", "egg"];
function featureRank(base: string): number {
  const i = FEATURED_DISHES.indexOf(base);
  return i === -1 ? FEATURED_DISHES.length : i;
}

/** An authored board without its screen id — buildPlan numbers boards sequentially after filtering. */
type Board = Omit<ThinPlan["screens"][number], "id">;

/**
 * Lead board: BIRYANI & PULAV combined — matched dish pairs, biryani beside its pulav. Returns
 * `null` when the (post-inventory) menu has too few biryani/pulav photo pairs to fill a grid, so
 * the plan simply skips it rather than shipping a thin board.
 */
function combinedBiryaniPulavBoard(menu: CanonicalItem[]): Board | null {
  const biryani = menu.filter((i) => i.category === "Biryani");
  const pulavByBase = new Map(
    menu.filter((i) => i.category === "Pulav").map((i) => [dishBase(i.name), i]),
  );
  const ordered = [...biryani].sort(
    (a, b) =>
      featureRank(dishBase(a.name)) - featureRank(dishBase(b.name)) || a.name.localeCompare(b.name),
  );

  const ids: string[] = [];
  for (const b of ordered) {
    const p = pulavByBase.get(dishBase(b.name));
    if (p && hasPhoto(b) && hasPhoto(p)) ids.push(b.id, p.id);
    if (ids.length >= GRID_CAPACITY) break;
  }
  if (ids.length < 2) return null; // not enough photo pairs in this batch — skip the board

  const items = ids.slice(0, GRID_CAPACITY);
  return {
    // No categoryId: this board spans two real categories, and the samples test requires a set
    // categoryId to match exactly one menu category.
    imageSlot: { items },
    sections: [{ title: "BIRYANI & PULAV", representation: "grid", items }],
  };
}

/**
 * Candidate category boards, in preference order — each becomes one photo-rich board (top-N photo
 * items in a grid + matching carousel). A category with <2 photo items is skipped, so the final
 * board count adapts to how many photos the (post-inventory) menu actually carries.
 */
const CATEGORY_BOARDS: { title: string; category: string }[] = [
  { title: "Biryani", category: "Biryani" },
  { title: "Veg Curries", category: "Veg Curries" },
  { title: "Non-Veg Curries", category: "Non Veg Curries" },
  { title: "Veg Appetizers", category: "Veg Appetizers" },
  { title: "Non-Veg Appetizers", category: "Non Veg Appetizers" },
  { title: "Indo-Chinese", category: "Indo Chinese" },
  { title: "Mandi", category: "Mandi" },
  { title: "Tandoori / Kebab", category: "Tandoori / Kebab" },
  { title: "Desserts", category: "Desserts" },
];
function categoryBoard(
  menu: CanonicalItem[],
  board: (typeof CATEGORY_BOARDS)[number],
): Board | null {
  const photoItems = menu
    .filter((i) => i.category === board.category && hasPhoto(i))
    .slice(0, GRID_CAPACITY);
  if (photoItems.length < 2) return null; // too few photos to fill a grid — skip
  const items = photoItems.map((i) => i.id);
  return {
    imageSlot: { categoryId: board.category, items },
    sections: [{ title: board.title.toUpperCase(), representation: "grid", items }],
  };
}

function buildPlan(menu: CanonicalItem[]): ThinPlan {
  const boards = [
    combinedBiryaniPulavBoard(menu),
    ...CATEGORY_BOARDS.map((b) => categoryBoard(menu, b)),
  ].filter((b): b is Board => b !== null);
  if (boards.length === 0) {
    throw new Error("no photo-rich boards could be authored — the menu has too few photos");
  }
  const screens = boards.map((b, i) => ({ ...b, id: `screen-${i + 1}` }));
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

/* ------------------------------------------------------------------------------------ run */
const raw = JSON.parse(readFileSync(SRC, "utf8")) as ToastExport;
const inventory = existsSync(INVENTORY)
  ? (JSON.parse(readFileSync(INVENTORY, "utf8")) as InventoryRecord[])
  : [];
const dropNames = outOfStockNames(raw, inventory);
const menu = buildMenu(raw, dropNames);

// Write the menu first: it is the primary fixture and must regenerate even if plan authoring (a
// best-effort, photo-dependent step) can't fill any board for a thin batch.
const withPhotos = menu.filter(hasPhoto).length;
writeFileSync(MENU_OUT, JSON.stringify(menu, null, 2) + "\n", "utf8");
console.warn(
  `regen-samples: wrote ${menu.length} items (${withPhotos} with photos) → samples/menu.json`,
);

const plan = buildPlan(menu);
assertPlanResolves(plan, menu);
writeFileSync(PLAN_OUT, JSON.stringify(plan, null, 2) + "\n", "utf8");
console.warn(
  `regen-samples: wrote ${plan.screens.length}-board plan → samples/plan.json\n` +
    plan.screens
      .map((s) => `  ${s.id}: ${s.sections[0]?.title} (${s.sections[0]?.items.length} items)`)
      .join("\n"),
);
