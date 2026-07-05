import { describe, expect, it } from "vitest";

import { defaultMenuLintConfig, menuLintConfigSchema } from "../config/menu-lint";
import type { CanonicalItem } from "../domain/types";
import { applyMenuRenderPolicy, MenuLintKind, runMenuLint } from "./menu-lint";

const cfg = defaultMenuLintConfig();

function item(over: Partial<CanonicalItem> & { id: string; name: string }): CanonicalItem {
  return { available: true, ...over };
}

describe("runMenuLint — price checks", () => {
  it("flags price-missing when there is no price, size, or priced variant", () => {
    const findings = runMenuLint([item({ id: "a", name: "Mystery Dish" })], cfg);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: MenuLintKind.PriceMissing, itemId: "a" });
  });

  it("does NOT flag a label-only variant item as price-zero (undefined variant price is legit)", () => {
    const findings = runMenuLint(
      [item({ id: "a", name: "Curry", variants: [{ label: "Veg" }, { label: "Paneer" }] })],
      cfg,
    );
    // No priced anything → price-missing, but never price-zero (there is no explicit 0).
    expect(findings.map((f) => f.kind)).toEqual([MenuLintKind.PriceMissing]);
  });

  it("flags price-zero for an explicit 0 base price", () => {
    const findings = runMenuLint([item({ id: "a", name: "Free Sample", price: 0 })], cfg);
    expect(findings.map((f) => f.kind)).toEqual([MenuLintKind.PriceZero]);
  });

  it("flags price-zero for a 0-priced size", () => {
    const findings = runMenuLint(
      [
        item({
          id: "a",
          name: "Combo",
          sizes: [
            { label: "S", price: 0 },
            { label: "L", price: 9 },
          ],
        }),
      ],
      cfg,
    );
    expect(findings.map((f) => f.kind)).toEqual([MenuLintKind.PriceZero]);
  });

  it("flags price-zero for a 0-priced variant", () => {
    const findings = runMenuLint(
      [item({ id: "a", name: "Wrap", variants: [{ label: "Veg", price: 0 }] })],
      cfg,
    );
    expect(findings.map((f) => f.kind)).toEqual([MenuLintKind.PriceZero]);
  });

  it("passes a well-priced item with no findings", () => {
    const findings = runMenuLint([item({ id: "a", name: "Latte", price: 4.5 })], cfg);
    expect(findings).toEqual([]);
  });
});

describe("runMenuLint — overlong checks honour config budgets", () => {
  it("flags name-overlong beyond the budget", () => {
    const tight = menuLintConfigSchema.parse({ maxNameChars: 10 });
    const findings = runMenuLint(
      [item({ id: "a", name: "A Very Long Dish Name", price: 5 })],
      tight,
    );
    expect(findings.map((f) => f.kind)).toEqual([MenuLintKind.NameOverlong]);
  });

  it("flags description-overlong beyond the budget", () => {
    const tight = menuLintConfigSchema.parse({ maxDescriptionChars: 5 });
    const findings = runMenuLint(
      [item({ id: "a", name: "Soup", price: 5, description: "way too long" })],
      tight,
    );
    expect(findings.map((f) => f.kind)).toEqual([MenuLintKind.DescriptionOverlong]);
  });

  it("does not flag a name/description within budget", () => {
    const findings = runMenuLint(
      [item({ id: "a", name: "Soup", price: 5, description: "warm" })],
      cfg,
    );
    expect(findings).toEqual([]);
  });

  it("can compound price + overlong findings on one item", () => {
    const tight = menuLintConfigSchema.parse({ maxNameChars: 4 });
    const findings = runMenuLint([item({ id: "a", name: "Freebie", price: 0 })], tight);
    expect(findings.map((f) => f.kind).sort()).toEqual(
      [MenuLintKind.NameOverlong, MenuLintKind.PriceZero].sort(),
    );
  });
});

describe("runMenuLint — duplicate-name dedup normalization", () => {
  it("flags a duplicate name in the same category (case/whitespace-insensitive)", () => {
    const findings = runMenuLint(
      [
        item({ id: "a", name: "Chicken 65", category: "Starters", price: 8 }),
        item({ id: "b", name: "  chicken   65 ", category: "Starters", price: 9 }),
      ],
      cfg,
    );
    const dup = findings.filter((f) => f.kind === MenuLintKind.DuplicateName);
    expect(dup).toHaveLength(1);
    // The SECOND occurrence is flagged, pointing back at the first item id.
    expect(dup[0]).toMatchObject({ itemId: "b", category: "Starters" });
    expect(dup[0]!.message).toContain('"a"');
  });

  it("treats a trailing spicy * marker as the same normalized name", () => {
    const findings = runMenuLint(
      [
        item({ id: "a", name: "Paneer Tikka", category: "Grill", price: 10 }),
        item({ id: "b", name: "Paneer Tikka*", category: "Grill", price: 10 }),
      ],
      cfg,
    );
    expect(findings.filter((f) => f.kind === MenuLintKind.DuplicateName)).toHaveLength(1);
  });

  it("does NOT flag the same name across DIFFERENT categories", () => {
    const findings = runMenuLint(
      [
        item({ id: "a", name: "House Special", category: "Veg", price: 10 }),
        item({ id: "b", name: "House Special", category: "Non-Veg", price: 12 }),
      ],
      cfg,
    );
    expect(findings.filter((f) => f.kind === MenuLintKind.DuplicateName)).toEqual([]);
  });

  it("treats items with no category as one shared 'uncategorized' bucket", () => {
    const findings = runMenuLint(
      [
        item({ id: "a", name: "Special", price: 10 }),
        item({ id: "b", name: "special", price: 11 }),
      ],
      cfg,
    );
    expect(findings.filter((f) => f.kind === MenuLintKind.DuplicateName)).toHaveLength(1);
  });
});

describe("applyMenuRenderPolicy", () => {
  it("strips a 0 base price so the item becomes priceless (hide, default)", () => {
    const out = applyMenuRenderPolicy([item({ id: "a", name: "Free", price: 0 })], cfg);
    expect(out[0]!.price).toBeUndefined();
    expect("price" in out[0]!).toBe(false);
  });

  it("drops a 0-priced size but keeps positive sizes", () => {
    const out = applyMenuRenderPolicy(
      [
        item({
          id: "a",
          name: "Combo",
          sizes: [
            { label: "S", price: 0 },
            { label: "L", price: 9 },
          ],
        }),
      ],
      cfg,
    );
    expect(out[0]!.sizes).toEqual([{ label: "L", price: 9 }]);
  });

  it("drops a 0 price off a variant while keeping its label", () => {
    const out = applyMenuRenderPolicy(
      [item({ id: "a", name: "Wrap", variants: [{ label: "Veg", price: 0 }] })],
      cfg,
    );
    expect(out[0]!.variants).toEqual([{ label: "Veg" }]);
  });

  it("keeps a 0 base price but a real size price (item stays priced by size)", () => {
    const out = applyMenuRenderPolicy(
      [item({ id: "a", name: "Pizza", price: 0, sizes: [{ label: "L", price: 12 }] })],
      cfg,
    );
    expect(out[0]!.price).toBeUndefined();
    expect(out[0]!.sizes).toEqual([{ label: "L", price: 12 }]);
  });

  it("returns the SAME array reference when nothing needs hiding", () => {
    const items = [item({ id: "a", name: "Latte", price: 4.5 })];
    expect(applyMenuRenderPolicy(items, cfg)).toBe(items);
  });

  it("is a no-op under zeroPriceRender:verbatim (same reference, $0.00 preserved)", () => {
    const verbatim = menuLintConfigSchema.parse({ zeroPriceRender: "verbatim" });
    const items = [item({ id: "a", name: "Free", price: 0 })];
    const out = applyMenuRenderPolicy(items, verbatim);
    expect(out).toBe(items);
    expect(out[0]!.price).toBe(0);
  });
});
