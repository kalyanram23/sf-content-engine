import { describe, expect, it } from "vitest";

import {
  comfortableRowBudget,
  computeTypeScale,
  densityTier,
  maxRowsForCanvas,
  sparseFillTargets,
} from "./sizing";

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

  it("enters the two-column over-budget regime once rows exceed even TWO comfortable columns (D26/D70)", () => {
    // Column-aware classification (D70): the ladder itself prescribes two columns beyond the
    // single-column budget, so a board is only genuinely over-budget when its rows exceed 2× the
    // budget (landscape budget = the 18-row canvas capacity → over-budget starts at 37 rows).
    // Categories are atomic (D25): there is no "split this board" signal — the board renders dense
    // with an explicit two-column directive instead.
    const max = maxRowsForCanvas(LANDSCAPE);
    const d = computeTypeScale(2 * max + 1, LANDSCAPE);
    expect(d.overBudget).toBe(true);
    expect(d.columns).toBe(2);
    expect(d.fits).toBe(true);
    expect(d.maxRows).toBe(max);
    expect(d.text).toMatch(/TWO balanced narrow columns/i);
    expect(d.text).not.toMatch(/split/i);
  });

  it("a board just over the single-column capacity is comfortable at TWO columns, not over-budget (D70)", () => {
    // The live-validated failure class: raw rows > budget but rows-per-column well within it — the
    // painter renders 2 columns at the compact floor pitch and under-fills. Effective load rules.
    const max = maxRowsForCanvas(LANDSCAPE);
    const d = computeTypeScale(max + 1, LANDSCAPE);
    expect(d.overBudget).toBe(false);
    expect(d.columns).toBe(2);
    expect(d.fits).toBe(true);
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

describe("computeTypeScale — comfortable directive gives BOTH layouts fill arithmetic", () => {
  it("quotes the single-column rung AND the bigger two-column rung, plus the dead-band defect", () => {
    // 18 rows on landscape (body ~815px = 1080 − 200 chrome − 65 masthead): single column →
    // text-xl/text-2xl; two columns of ~9 rows cover only half the height at that size, so the
    // painter must step UP to the ladder rung for 9 rows (text-2xl/text-3xl) and/or hand the
    // reclaimed height to the image slot.
    const d = computeTypeScale(18, LANDSCAPE);
    expect(d.columns).toBe(1);
    expect(d.scale).toEqual({ names: "text-xl", prices: "text-2xl" }); // single-column rung preserved
    expect(d.text).toMatch(/~815px of body height must be SPANNED/);
    // The quoted body height already reserves the masthead band — the painter must not double-reserve.
    expect(d.text).toMatch(/ALREADY reserves the slim masthead band/);
    expect(d.text).toMatch(/Single column → names at text-xl, prices text-2xl/);
    expect(d.text).toMatch(/TWO columns \(~9 rows\/col\)/);
    expect(d.text).toMatch(/text-2xl\/text-3xl, computed from the ladder for 9 rows/);
    expect(d.text).toMatch(/hero up to ~40% of the canvas/);
    expect(d.text).toMatch(/taller than ~15% of the body is a defect/);
  });

  it("the two-column rung is never smaller than the single-column rung (going UP, not down)", () => {
    const sizeRank = ["text-xl", "text-2xl", "text-3xl"];
    for (let rows = 1; rows <= maxRowsForCanvas(LANDSCAPE); rows += 1) {
      const d = computeTypeScale(rows, LANDSCAPE);
      if (d.overBudget) continue; // only the comfortable branch carries the two-column rung text
      const single = sizeRank.indexOf(d.scale.names);
      const twoColMatch = d.text.match(/\((text-\w+)\/text-\w+, computed from the ladder/);
      const twoCol = sizeRank.indexOf(twoColMatch?.[1] ?? "");
      expect(twoCol).toBeGreaterThanOrEqual(single);
    }
  });
});

describe("computeTypeScale — over-budget regime (D26, column-aware since D70)", () => {
  it("a ~50-row single-category portrait board gets a two-column directive at readable sizes", () => {
    // 50 rows exceed even TWO comfortable columns (2×24-row budget) → the genuinely over-budget
    // dense regime: two balanced columns of 25 at the top over-budget rung (text-xl).
    const d = computeTypeScale(50, PORTRAIT, undefined, 24);
    expect(d.overBudget).toBe(true);
    expect(d.columns).toBe(2);
    expect(d.fits).toBe(true);
    expect(d.scale).toEqual({ names: "text-xl", prices: "text-2xl" });
    expect(d.text).toMatch(/TWO balanced narrow columns/i);
    expect(d.text).toMatch(/~25 rows per column/);
    expect(d.text).toMatch(/already excludes the slim masthead band/);
    expect(d.text).toMatch(/never shrink below/i);
  });

  it("respects a custom comfortable budget (planning.legibilityBudget)", () => {
    // Budget 12: over-budget begins past TWO comfortable columns (25+ rows); 20 rows are
    // comfortable at 2×10/col (D70); 10 rows are comfortable in one column.
    expect(computeTypeScale(25, LANDSCAPE, undefined, 12).overBudget).toBe(true);
    expect(computeTypeScale(20, LANDSCAPE, undefined, 12).overBudget).toBe(false);
    expect(computeTypeScale(20, LANDSCAPE, undefined, 12).columns).toBe(2);
    expect(computeTypeScale(10, LANDSCAPE, undefined, 12).overBudget).toBe(false);
    expect(computeTypeScale(10, LANDSCAPE, undefined, 12).columns).toBe(1);
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
    // Over-budget begins at 49 rows (2×24 budget + 1) on portrait since D70.
    const sizeRank = ["text-base", "text-lg", "text-xl"];
    let prev = Infinity;
    for (let rows = 49; rows <= 96; rows += 1) {
      const d = computeTypeScale(rows, PORTRAIT, undefined, 24);
      expect(d.overBudget).toBe(true);
      const rank = sizeRank.indexOf(d.scale.names);
      expect(rank).toBeLessThanOrEqual(prev);
      prev = rank;
    }
  });
});

/**
 * D70 — the SPARSE size directive: concrete, computed rem targets for a comfortable-tier board so
 * the painter stops copying the exemplar's dense floor-scale sizes onto a board with room to breathe
 * (relative "scale up" prose never moved it). `sparseFillTargets` distributes the usable body height
 * — canvas minus frame inset, masthead band, and per-section header overhead — across the rows PER
 * COLUMN; a 2-column layout halves the effective rows and so earns a bigger per-row target.
 */
describe("sparseFillTargets — concrete rem targets for a sparse board (D70)", () => {
  it("distributes the usable body across single-column rows (18 rows / 6 sections portrait)", () => {
    const t = sparseFillTargets(18, PORTRAIT, 6, 1);
    // body 1605px = 100.3rem; overhead 6×3 + 5×2 = 28rem; usable 72.3rem / 18 rows ≈ 4.0rem/row.
    expect(t.rowsPerColumn).toBe(18);
    expect(t.rowHeightRem).toBe(4);
    expect(t.typeRem).toBe(1.75);
    expect(t.sectionSpacingRem).toBe(2);
    expect(t.photoBandRem).toBeGreaterThan(0);
  });

  it("halves effective rows for a 2-column layout → a bigger per-row target", () => {
    const single = sparseFillTargets(18, PORTRAIT, 6, 1);
    const dual = sparseFillTargets(18, PORTRAIT, 6, 2);
    expect(dual.rowsPerColumn).toBe(9); // ceil(18/2)
    expect(dual.rowHeightRem).toBeGreaterThan(single.rowHeightRem);
    expect(dual.rowHeightRem).toBe(8);
    expect(dual.typeRem).toBe(3);
  });

  it("subtracts more header overhead when there are more sections → smaller per-row target", () => {
    const few = sparseFillTargets(12, PORTRAIT, 2, 1);
    const many = sparseFillTargets(12, PORTRAIT, 8, 1);
    expect(many.rowHeightRem).toBeLessThanOrEqual(few.rowHeightRem);
  });

  it("clamps the type target to a sane ceiling even when rows are very few", () => {
    const t = sparseFillTargets(3, PORTRAIT, 1, 2);
    expect(t.typeRem).toBeLessThanOrEqual(3);
    expect(t.typeRem).toBeGreaterThanOrEqual(1.25);
  });

  it("rounds to sane rem steps (row height to 0.25rem, type to 0.25rem, photo band to 1rem)", () => {
    const t = sparseFillTargets(18, PORTRAIT, 6, 1);
    expect((t.rowHeightRem * 4) % 1).toBe(0); // multiple of 0.25
    expect((t.typeRem * 4) % 1).toBe(0);
    expect(t.photoBandRem % 1).toBe(0); // whole rem
  });
});

describe("computeTypeScale — comfortable branch emits the concrete SIZE DIRECTIVE (D70)", () => {
  it("appends computed rem targets to the comfortable directive (single + two column)", () => {
    const d = computeTypeScale(18, PORTRAIT, undefined, 24, 6);
    expect(d.overBudget).toBe(false);
    // The legacy TYPE SCALE prose is preserved as the prefix (its consumers still pass).
    expect(d.text).toMatch(/^TYPE SCALE:/);
    // The new concrete directive with obeyable rem numbers.
    expect(d.text).toContain("SIZE DIRECTIVE (sparse board");
    expect(d.text).toContain("Single column (18 rows): target row height ≈ 4rem");
    expect(d.text).toContain("item name/price type ≈ 1.75rem");
    expect(d.text).toContain("Two columns (~9 rows/col): target row height ≈ 8rem");
    expect(d.text).toContain("type ≈ 3rem");
    expect(d.text).toContain("Section spacing ≈ 2rem");
    expect(d.text).toContain("within ~2rem of the bottom frame");
  });

  it("the section count changes the emitted row-height target (header overhead is real)", () => {
    const few = computeTypeScale(12, PORTRAIT, undefined, 24, 2).text;
    const many = computeTypeScale(12, PORTRAIT, undefined, 24, 10).text;
    expect(few).not.toBe(many);
  });
});

/**
 * D70 column-aware classification: the live-validated failing shape — 36 rows / 6 sections on
 * 1080×1920 — classifies OVER the raw 24-row budget, but the ladder renders it as 2×18, i.e. an
 * effectively-18-row board. It must get the concrete sparse targets for the TWO-column layout it
 * will actually paint (the dense floor-scale directive measurably under-fills it: ~26–31% vs 40%).
 */
describe("computeTypeScale — comfortable at TWO columns (D70, the 36-row failing shape)", () => {
  it("classifies 36 rows / 6 sections portrait as comfortable-at-2-columns with concrete targets", () => {
    const d = computeTypeScale(36, PORTRAIT, undefined, 24, 6);
    expect(d.overBudget).toBe(false);
    expect(d.columns).toBe(2);
    expect(d.fits).toBe(true);
    // The COMFORTABLE ladder rung for 18 rows/col — not the over-budget floor rung.
    expect(d.scale).toEqual({ names: "text-2xl", prices: "text-3xl" });
    expect(d.text).toMatch(/^TYPE SCALE \(two-column comfortable board\)/);
    expect(d.text).toContain("SIZE DIRECTIVE (sparse two-column board, 36 rows across 6 sections");
    expect(d.text).toContain("~18 rows per column");
    expect(d.text).toContain("target row height ≈ 4rem");
    expect(d.text).toContain("type ≈ 1.75rem");
    expect(d.text).toContain("Section spacing ≈ 2rem");
    expect(d.text).toContain("within ~2rem of the bottom frame");
    // No misleading single-column option: 36 rows cannot fit ONE comfortable column.
    expect(d.text).not.toContain("Single column (36 rows)");
  });

  it("emits the SAME per-row targets as the equivalent 18-row single-column board", () => {
    // The whole point: 36 rows at 2 columns IS an 18-row board per column.
    expect(sparseFillTargets(36, PORTRAIT, 6, 2)).toEqual(sparseFillTargets(18, PORTRAIT, 6, 1));
  });

  it("the band ends at exactly two comfortable columns (boundary 2×budget)", () => {
    expect(computeTypeScale(48, PORTRAIT, undefined, 24, 6).overBudget).toBe(false);
    expect(computeTypeScale(48, PORTRAIT, undefined, 24, 6).columns).toBe(2);
    expect(computeTypeScale(49, PORTRAIT, undefined, 24, 6).overBudget).toBe(true);
  });
});

describe("computeTypeScale — the dense (over-budget) path is byte-unchanged by D70", () => {
  it("carries NO sparse SIZE DIRECTIVE", () => {
    // 60 rows: ceil(60/2)=30 > the 24-row budget → a TRUE dense case under column-aware selection.
    const d = computeTypeScale(60, PORTRAIT, undefined, 24, 6);
    expect(d.overBudget).toBe(true);
    expect(d.text).not.toContain("SIZE DIRECTIVE (sparse");
  });

  it("is byte-identical regardless of the new section-count argument", () => {
    // Proves the sections param only feeds the sparse branch — the dense text never drifts.
    expect(computeTypeScale(60, PORTRAIT, undefined, 24, 6).text).toBe(
      computeTypeScale(60, PORTRAIT, undefined, 24, 1).text,
    );
    // …and equals the pre-D70 call shape (sections omitted) exactly.
    expect(computeTypeScale(60, PORTRAIT, undefined, 24, 6).text).toBe(
      computeTypeScale(60, PORTRAIT, undefined, 24).text,
    );
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

describe("densityTier — column-aware tiers against the per-column budget (D30, D70)", () => {
  it("stays comfortable while the rows fit the budget PER COLUMN at the ladder's column choice", () => {
    expect(densityTier(10, 10)).toBe("comfortable"); // == budget, one column
    expect(densityTier(11, 10)).toBe("comfortable"); // 2×6/col — fits two comfortable columns (D70)
    expect(densityTier(20, 10)).toBe("comfortable"); // 2×10/col — exactly two full comfortable columns
    expect(densityTier(21, 10)).toBe("packed"); // 11/col over budget AND > packedMultiplier×budget
  });

  it("respects a custom packed multiplier (the dense band survives for multiplier > 2)", () => {
    expect(densityTier(25, 10, 3)).toBe("dense"); // 13/col over budget, ≤ 3×budget
    expect(densityTier(31, 10, 3)).toBe("packed"); // > 3×budget
  });

  it("agrees with computeTypeScale's branch selection — ONE notion of density (D70)", () => {
    // The reconciliation invariant: with the default multiplier, a board is comfortable-tier
    // exactly when the sizing directive takes a comfortable (non-over-budget) branch. This is what
    // keeps the painter register, the critic, QA's plan-forced allowance and the sizing targets
    // from ever disagreeing about what a board is.
    const budget = comfortableRowBudget(PORTRAIT, 24);
    for (let rows = 1; rows <= 60; rows += 1) {
      const tier = densityTier(rows, budget);
      const d = computeTypeScale(rows, PORTRAIT, undefined, 24, 4);
      expect(tier === "comfortable").toBe(!d.overBudget);
    }
  });
});
