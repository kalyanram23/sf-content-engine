import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";

import type { PlanScreen } from "../domain/types";
import { checkMatrixStructure } from "./structural-checks";

/** A plan section carrying a computed 2-column matrix (Chicken paired, Egg only in Biryani). */
const planScreen: PlanScreen = {
  id: "screen-1",
  sections: [
    {
      title: "Biryani & Pulav",
      representation: "matrix",
      items: ["b-chicken", "p-chicken", "b-egg"],
      matrix: {
        columns: ["Biryani", "Pulav"],
        rows: [
          { label: "Chicken", cells: ["b-chicken", "p-chicken"] },
          { label: "Egg", cells: ["b-egg", null] },
        ],
      },
    },
  ],
};

/** A valid table honouring the matrix-first skeleton. */
const VALID = `
<div data-matrix>
  <div data-matrix-head><span></span><span>Biryani</span><span>Pulav</span></div>
  <div data-matrix-row="Chicken">
    <span>Chicken</span>
    <div data-matrix-cell="Biryani" data-item-id="b-chicken" data-available="true"><span data-bind="price">$12.00</span></div>
    <div data-matrix-cell="Pulav" data-item-id="p-chicken" data-available="true"><span data-bind="price">$11.00</span></div>
  </div>
  <div data-matrix-row="Egg">
    <span>Egg</span>
    <div data-matrix-cell="Biryani" data-item-id="b-egg" data-available="true"><span data-bind="price">$10.00</span></div>
    <div data-matrix-cell="Pulav">—</div>
  </div>
</div>`;

describe("checkMatrixStructure (§ Phase 4)", () => {
  it("passes a valid comparison table", () => {
    expect(checkMatrixStructure(parse(VALID), planScreen)).toHaveLength(0);
  });

  it("flags when the painter rendered no data-matrix table at all", () => {
    const stacked = `<div><article data-item-id="b-chicken"><span data-bind="price">$12</span></article></div>`;
    const findings = checkMatrixStructure(parse(stacked), planScreen);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "matrix-structure", severity: "major" });
    expect(findings[0]?.message).toMatch(/no data-matrix table/i);
  });

  it("flags a null cell that carries a price span (should be a bare em-dash)", () => {
    const badNull = VALID.replace(
      '<div data-matrix-cell="Pulav">—</div>',
      '<div data-matrix-cell="Pulav"><span data-bind="price">$0</span></div>',
    );
    const findings = checkMatrixStructure(parse(badNull), planScreen);
    expect(findings.some((f) => /empty matrix cell/i.test(f.message))).toBe(true);
  });

  it("flags a filled cell with more than one price span", () => {
    const twoPrices = VALID.replace(
      '<div data-matrix-cell="Biryani" data-item-id="b-chicken" data-available="true"><span data-bind="price">$12.00</span></div>',
      '<div data-matrix-cell="Biryani" data-item-id="b-chicken" data-available="true"><span data-bind="price">$12.00</span><span data-bind="price">$13.00</span></div>',
    );
    const findings = checkMatrixStructure(parse(twoPrices), planScreen);
    expect(findings.some((f) => f.itemId === "b-chicken" && /price.*span/i.test(f.message))).toBe(
      true,
    );
  });

  it("flags a row that has the wrong number of cell slots", () => {
    const missingCell = VALID.replace(
      '<div data-matrix-cell="Pulav" data-item-id="p-chicken" data-available="true"><span data-bind="price">$11.00</span></div>',
      "",
    );
    const findings = checkMatrixStructure(parse(missingCell), planScreen);
    expect(findings.some((f) => /cell\(s\); expected 2/i.test(f.message))).toBe(true);
  });

  it("flags an item placed in the wrong column", () => {
    const wrongCol = VALID.replace(
      '<div data-matrix-cell="Biryani" data-item-id="b-chicken"',
      '<div data-matrix-cell="Pulav" data-item-id="b-chicken"',
    );
    const findings = checkMatrixStructure(parse(wrongCol), planScreen);
    expect(
      findings.some((f) => f.itemId === "b-chicken" && /expected "Biryani"/i.test(f.message)),
    ).toBe(true);
  });

  it("ignores sections that carry no matrix data", () => {
    const plain: PlanScreen = {
      id: "s",
      sections: [{ title: "Sides", representation: "list", items: ["x"] }],
    };
    expect(checkMatrixStructure(parse("<div><span>hi</span></div>"), plain)).toHaveLength(0);
  });
});
