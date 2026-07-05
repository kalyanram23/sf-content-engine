import { describe, expect, it } from "vitest";

import { comfortableRowBudget, computeTypeScale, densityTier, maxRowsForCanvas } from "./sizing";

const LANDSCAPE = { width: 1920, height: 1080 };
const PORTRAIT = { width: 1080, height: 1920 };

describe("computeTypeScale — ladder boundaries (landscape 1920×1080)", () => {
  it("uses the largest type for a few rows", () => {
    const d = computeTypeScale(6, LANDSCAPE);
    expect(d.fits).toBe(true);
    expect(d.scale).toEqual({ names: "text-3xl", prices: "text-4xl" });
  });

  it("steps down to the mid rung around 14 rows", () => {
    const d = computeTypeScale(12, LANDSCAPE);
    expect(d.fits).toBe(true);
    expect(d.scale).toEqual({ names: "text-2xl", prices: "text-3xl" });
  });

  it("steps down to the smallest rung around 20 rows", () => {
    const d = computeTypeScale(18, LANDSCAPE);
    expect(d.fits).toBe(true);
    expect(d.scale).toEqual({ names: "text-xl", prices: "text-2xl" });
  });

  it("enters the two-column over-budget regime once rows exceed the canvas capacity (D26)", () => {
    const max = maxRowsForCanvas(LANDSCAPE);
    const d = computeTypeScale(max + 1, LANDSCAPE);
    // Categories are atomic (D25): there is no "split this board" signal any more — the board
    // renders dense with an explicit two-column directive instead.
    expect(d.overBudget).toBe(true);
    expect(d.columns).toBe(2);
    expect(d.fits).toBe(true);
    expect(d.maxRows).toBe(max);
    expect(d.text).toMatch(/TWO balanced narrow columns/i);
    expect(d.text).not.toMatch(/split/i);
  });

  it("is monotonic: larger row counts never pick a larger type", () => {
    const sizeRank = ["text-xl", "text-2xl", "text-3xl"];
    let prev = Infinity;
    for (let rows = 1; rows <= maxRowsForCanvas(LANDSCAPE); rows += 1) {
      const rank = sizeRank.indexOf(computeTypeScale(rows, LANDSCAPE).scale.names);
      expect(rank).toBeLessThanOrEqual(prev);
      prev = rank;
    }
  });

  it("stays single-column within the comfortable budget", () => {
    const d = computeTypeScale(18, LANDSCAPE);
    expect(d.overBudget).toBe(false);
    expect(d.columns).toBe(1);
  });
});

describe("computeTypeScale — over-budget regime (D26)", () => {
  it("a ~34-row single-category portrait board gets a two-column directive at readable sizes", () => {
    // 34 rows > the 24-row comfortable budget (even though portrait physically holds ~39 in one
    // column at the smallest rung) → two balanced columns of 17, back UP at text-xl.
    const d = computeTypeScale(34, PORTRAIT, undefined, 24);
    expect(d.overBudget).toBe(true);
    expect(d.columns).toBe(2);
    expect(d.fits).toBe(true);
    expect(d.scale).toEqual({ names: "text-xl", prices: "text-2xl" });
    expect(d.text).toMatch(/TWO balanced narrow columns/i);
    expect(d.text).toMatch(/~17 rows per column/);
    expect(d.text).toMatch(/never shrink below/i);
  });

  it("respects a custom comfortable budget (planning.legibilityBudget)", () => {
    expect(computeTypeScale(20, LANDSCAPE, undefined, 12).overBudget).toBe(true);
    expect(computeTypeScale(10, LANDSCAPE, undefined, 12).overBudget).toBe(false);
  });

  it("never prescribes below the engine floors, even when nothing fits", () => {
    // 100 rows on landscape: even two columns at the text-base floor can't hold 50/column.
    const d = computeTypeScale(100, LANDSCAPE);
    expect(d.fits).toBe(false);
    expect(d.overBudget).toBe(true);
    expect(d.columns).toBe(2);
    expect(d.scale).toEqual({ names: "text-base", prices: "text-lg" });
    expect(d.text).toMatch(/absolute floor/i);
    expect(d.text).toMatch(/DO NOT overflow/i);
    // Never tells the painter the plan "should have split" — atomicity is deliberate (D25).
    expect(d.text).not.toMatch(/split/i);
  });

  it("the over-budget ladder is monotonic too: more rows never pick a larger type", () => {
    const sizeRank = ["text-base", "text-lg", "text-xl"];
    let prev = Infinity;
    for (let rows = 25; rows <= 80; rows += 1) {
      const d = computeTypeScale(rows, PORTRAIT, undefined, 24);
      const rank = sizeRank.indexOf(d.scale.names);
      expect(rank).toBeLessThanOrEqual(prev);
      prev = rank;
    }
  });
});

describe("maxRowsForCanvas — a taller canvas holds more rows", () => {
  it("fits proportionally more rows in portrait than landscape", () => {
    expect(maxRowsForCanvas(PORTRAIT)).toBeGreaterThan(maxRowsForCanvas(LANDSCAPE));
  });
});

describe("comfortableRowBudget — config budget tightened to the canvas (D30)", () => {
  it("returns the config budget when the canvas holds at least that many rows", () => {
    // Portrait holds well over 24 rows at the smallest rung → the 24-row config budget stays.
    expect(comfortableRowBudget(PORTRAIT, 24)).toBe(24);
  });

  it("tightens to the canvas capacity when it holds fewer than the config budget", () => {
    const tiny = { width: 400, height: 300 };
    expect(comfortableRowBudget(tiny, 24)).toBe(maxRowsForCanvas(tiny));
    expect(comfortableRowBudget(tiny, 24)).toBeLessThan(24);
  });
});

describe("densityTier — comfortable / dense / packed against the budget (D30)", () => {
  it("classifies at the budget and 2× budget edges", () => {
    expect(densityTier(10, 10)).toBe("comfortable"); // == budget
    expect(densityTier(11, 10)).toBe("dense");
    expect(densityTier(20, 10)).toBe("dense"); // == 2×budget
    expect(densityTier(21, 10)).toBe("packed");
  });

  it("respects a custom packed multiplier", () => {
    expect(densityTier(25, 10, 3)).toBe("dense"); // ≤ 3×budget
    expect(densityTier(31, 10, 3)).toBe("packed"); // > 3×budget
  });
});
