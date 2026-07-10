import { describe, expect, it } from "vitest";

import type { CanonicalItem, DensityTier, PlanScreen } from "../../domain/types";
import {
  boardRowCount,
  densityTierFor,
  effectiveScreen,
  sizeDirectiveFor,
  typeScaleFor,
} from "./shared";

function item(id: string, images?: string[]): CanonicalItem {
  return { id, name: id, category: "c", available: true, ...(images ? { images } : {}) };
}

const DATA_URI = "data:image/png;base64,AAAA";

describe("effectiveScreen — photo truth for the imageSlot (paint + vision share it)", () => {
  const screen: PlanScreen = {
    id: "s1",
    imageSlot: { categoryId: "combo", items: ["a", "b", "c"] },
    sections: [{ title: "T", representation: "grid", items: ["a", "b", "c"] }],
  };

  it("returns the screen unchanged when every slot item still has a photo", () => {
    const items = [item("a", [DATA_URI]), item("b", [DATA_URI]), item("c", [DATA_URI])];
    expect(effectiveScreen(screen, items)).toBe(screen);
  });

  it("filters slot items whose photos were dropped by the fetch", () => {
    // b's photo failed to fetch (images dropped entirely); c never had one.
    const items = [item("a", [DATA_URI]), item("b"), item("c", [])];
    const effective = effectiveScreen(screen, items);
    expect(effective.imageSlot?.items).toEqual(["a"]);
    // categoryId is preserved, sections untouched (presentation changes, coverage never does).
    expect(effective.imageSlot?.categoryId).toBe("combo");
    expect(effective.sections).toEqual(screen.sections);
  });

  it("drops the imageSlot entirely when no slot item has a photo left", () => {
    const items = [item("a"), item("b"), item("c")];
    const effective = effectiveScreen(screen, items);
    expect(effective.imageSlot).toBeUndefined();
    // The key is absent, not set to undefined (exactOptionalPropertyTypes discipline).
    expect("imageSlot" in effective).toBe(false);
    expect(effective.sections).toEqual(screen.sections);
  });

  it("passes a screen without an imageSlot straight through", () => {
    const bare: PlanScreen = {
      id: "s2",
      sections: [{ title: "T", representation: "list", items: ["a"] }],
    };
    expect(effectiveScreen(bare, [item("a")])).toBe(bare);
  });

  it("omits categoryId (never undefined) when the original slot had none", () => {
    const noCat: PlanScreen = {
      id: "s3",
      imageSlot: { items: ["a", "b"] },
      sections: [{ title: "T", representation: "grid", items: ["a", "b"] }],
    };
    const effective = effectiveScreen(noCat, [item("a", [DATA_URI]), item("b")]);
    expect(effective.imageSlot?.items).toEqual(["a"]);
    expect("categoryId" in (effective.imageSlot ?? {})).toBe(false);
  });
});

describe("typeScaleFor / sizeDirectiveFor — one sizing verdict for painter, critic and QA", () => {
  const boardOf = (n: number): PlanScreen => ({
    id: "s1",
    sections: [
      { title: "T", representation: "list", items: Array.from({ length: n }, (_, i) => `i${i}`) },
    ],
  });
  const viewport = { width: 1080, height: 1920 };

  it("marks a board over even two comfortable columns as over-budget (D26, column-aware D70)", () => {
    const directive = typeScaleFor(boardOf(50), viewport, { legibilityBudget: 24 });
    expect(directive.overBudget).toBe(true);
    expect(directive.columns).toBe(2);
    expect(boardRowCount(boardOf(50))).toBe(50);
    // The prompt text is exactly the directive's text — painter and critic see the same words.
    expect(sizeDirectiveFor(boardOf(50), viewport, { legibilityBudget: 24 })).toBe(directive.text);
  });

  it("a board over the raw budget but within two comfortable columns is NOT over-budget (D70)", () => {
    // 34 rows on portrait (budget 24) render as 2×17 — an effectively-comfortable board that gets
    // the concrete sparse two-column targets, not the dense floor directive.
    const directive = typeScaleFor(boardOf(34), viewport, { legibilityBudget: 24 });
    expect(directive.overBudget).toBe(false);
    expect(directive.columns).toBe(2);
    expect(directive.text).toContain("SIZE DIRECTIVE (sparse two-column board");
  });

  it("stays within budget for a comfortable board", () => {
    const directive = typeScaleFor(boardOf(12), viewport, { legibilityBudget: 24 });
    expect(directive.overBudget).toBe(false);
    expect(directive.columns).toBe(1);
  });
});

describe("densityTierFor — stamped tier wins, else recomputed (D30)", () => {
  const listBoard = (n: number, tier?: DensityTier): PlanScreen => ({
    id: "s1",
    sections: [
      { title: "T", representation: "list", items: Array.from({ length: n }, (_, i) => `i${i}`) },
    ],
    ...(tier !== undefined ? { densityTier: tier } : {}),
  });
  const viewport = { width: 1920, height: 1080 };

  it("returns the tier stamped on the plan verbatim (never recomputes)", () => {
    // 50 rows would recompute to packed, but the stamped tier is authoritative.
    expect(densityTierFor(listBoard(50, "comfortable"), viewport, { legibilityBudget: 24 })).toBe(
      "comfortable",
    );
  });

  it("recomputes the tier for a hand-authored plan that carries none", () => {
    // Landscape budget tightens to the 18-row canvas capacity; classification is column-aware
    // (D70): 30 rows render as 2×15 — within budget per column → comfortable, not dense.
    expect(densityTierFor(listBoard(12), viewport, { legibilityBudget: 24 })).toBe("comfortable");
    expect(densityTierFor(listBoard(30), viewport, { legibilityBudget: 24 })).toBe("comfortable");
    expect(densityTierFor(listBoard(40), viewport, { legibilityBudget: 24 })).toBe("packed");
    expect(densityTierFor(listBoard(60), viewport, { legibilityBudget: 24 })).toBe("packed");
  });
});
