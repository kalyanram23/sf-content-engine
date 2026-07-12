// src/composition/layout.test.ts
import { describe, expect, it } from "vitest";

import type { ComponentVocabulary } from "../ports/vocabulary-registry";
import { fit, partitionColumns, planLayout } from "./layout";

/** Minimal deterministic vocabulary: every row 20px, headers 40px, two registers. */
const testVocab = {
  id: "test",
  version: 1,
  registerNames: ["L", "S"],
  defaultPhotoMode: "static",
  contentBox: (c) => ({ width: c.width - 100, height: c.height - 200 }),
  minStreamWidth: 300,
  sectionGap: 10,
  landscapeBannerHeight: 150,
  metrics: (register: string) => {
    const row = register === "L" ? 30 : 20;
    return {
      sectionHeight: (n: number, cols: number) => 40 + Math.ceil(n / cols) * row,
      groupHeight: (ns: number[]) => 30 + Math.max(...ns) * row,
      photoBandHeight: () => 200,
      flowRowHeight: () => row,
      flowLeadHeight: () => 40 + row,
      cueHeight: () => 24,
      sectionInternalCols: (n: number, max: number) => (n <= 4 ? 1 : max),
    };
  },
  renderShell: ({ bodyHtml }) => `<div>${bodyHtml}</div>`,
  renderSection: () => "<div></div>",
  renderGroup: () => "<div></div>",
  renderPhotoBand: () => "<div></div>",
  renderFlowLead: () => "<div></div>",
  renderFlowRow: () => "<div></div>",
  renderContinuationCue: () => "<div></div>",
  promptNotes: { section: "", group: "", photoBand: "" },
} satisfies ComponentVocabulary;

const sections = new Map(
  [
    {
      title: "A",
      items: Array.from({ length: 10 }, (_, i) => ({
        id: `a${i}`,
        name: `A${i}`,
        price: 1,
        hasImage: false,
      })),
    },
    {
      title: "B",
      items: Array.from({ length: 6 }, (_, i) => ({
        id: `b${i}`,
        name: `B${i}`,
        price: 1,
        hasImage: false,
      })),
    },
  ].map((s) => [s.title, s]),
);

describe("planLayout", () => {
  it("portrait → stack; landscape → columns with a searchable column range", () => {
    expect(planLayout({ width: 1080, height: 1920 }, testVocab).mode).toBe("stack");
    const l = planLayout({ width: 1920, height: 1080 }, testVocab);
    expect(l.mode).toBe("columns");
    expect(l.minColumns).toBe(2);
    expect(l.maxColumns).toBeGreaterThanOrEqual(2);
  });
});

describe("fit", () => {
  it("stack: picks the LARGEST register that fits within the fill target", () => {
    const plan = planLayout({ width: 1080, height: 1920 }, testVocab);
    const res = fit({
      blocks: [
        { kind: "section", section: "A", sections: [], itemIds: [] },
        { kind: "section", section: "B", sections: [], itemIds: [] },
      ],
      sectionsByTitle: sections,
      plan,
      vocab: testVocab,
    });
    expect(res.register).toBe("L"); // 2 sections easily fit at L in 1720px of body
    expect(res.layout.mode).toBe("stack");
  });

  it("falls to the smaller register when the large one overflows", () => {
    const tall = new Map(
      [
        {
          title: "BIG",
          items: Array.from({ length: 200 }, (_, i) => ({
            id: `x${i}`,
            name: `X${i}`,
            price: 1,
            hasImage: false,
          })),
        },
      ].map((s) => [s.title, s]),
    );
    const plan = planLayout({ width: 1080, height: 1920 }, testVocab);
    const res = fit({
      blocks: [{ kind: "section", section: "BIG", sections: [], itemIds: [] }],
      sectionsByTitle: tall,
      plan,
      vocab: testVocab,
    });
    expect(res.register).toBe("S"); // 100 rows/col at L = 3040px > 0.92*1720
  });
});

describe("partitionColumns", () => {
  it("balances measured units into contiguous groups and never splits a lead from index 0", () => {
    const units = [
      { height: 50, isLead: true },
      ...Array.from({ length: 9 }, () => ({ height: 20, isLead: false })),
      { height: 50, isLead: true },
      ...Array.from({ length: 5 }, () => ({ height: 20, isLead: false })),
    ];
    const groups = partitionColumns(units, 2, 24);
    expect(groups).toHaveLength(2);
    // contiguous + total coverage
    expect(groups.flat()).toEqual(Array.from({ length: units.length }, (_, i) => i));
    // balance: tallest column within one row of the ideal half
    const heightOf = (g: number[]) => g.reduce((s, i) => s + units[i]!.height, 0);
    expect(Math.abs(heightOf(groups[0]!) - heightOf(groups[1]!))).toBeLessThanOrEqual(50);
  });
});
