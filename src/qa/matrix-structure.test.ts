import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";

import type { PlanLayout } from "../domain/contracts";
import type { CanonicalItem, PlanScreen } from "../domain/types";
import { expandLayoutToPlan } from "../planning/coverage";
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

describe("checkMatrixStructure — composed-board trust (D73)", () => {
  // A v1 vocabulary renders a `representation: "matrix"` section as a plain price LIST — it has no
  // data-matrix DOM. The composed-root marker tells the check to trust it: coverage + binding
  // integrity still guarantee every priced item is present, and the fixed-table contract is a
  // free-paint contract. Without the skip this fires an UNFIXABLE major every iteration → routing
  // rule 92 → re-paint loop → budget burn → freeze flagged. (Vocabulary v2's combo/matrix component
  // re-enables it.) The SAME list DOM without the marker still fires — the non-regression pin.
  const listBody =
    `<article data-item-id="b-chicken"><span data-bind="price">$12.00</span></article>` +
    `<article data-item-id="p-chicken"><span data-bind="price">$11.00</span></article>` +
    `<article data-item-id="b-egg"><span data-bind="price">$10.00</span></article>`;

  it("SKIPS a composed root that renders a matrix section as a price list", () => {
    const composed = `<div data-composed="dhaba@1">${listBody}</div>`;
    expect(checkMatrixStructure(parse(composed), planScreen)).toHaveLength(0);
  });

  it("still fires on the SAME list DOM without the composed marker (non-regression pin)", () => {
    const findings = checkMatrixStructure(parse(`<div>${listBody}</div>`), planScreen);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "matrix-structure", severity: "major" });
    expect(findings[0]?.message).toMatch(/no data-matrix table/i);
  });

  // deterministicQA runs the structural checks against the PACKAGED document (state.packagedHtml),
  // not the raw fragment — the packager wraps the composed fragment in <!doctype html><html>…<body>.
  // The skip must survive that wrapper: the composed marker now sits as <body>'s first element child,
  // not the parsed root's (that's <html>). Without the document-shape detection this major fires
  // every iteration on the real pipeline path → routing rule 92 → re-paint loop → budget burn.
  const packagedDoc = (fragment: string): string =>
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>.x{}</style></head>` +
    `<body>${fragment}</body></html>`;

  it("SKIPS a PACKAGED composed document (marker inside the packager's <body> wrapper)", () => {
    const doc = packagedDoc(`<div data-composed="dhaba@1">${listBody}</div>`);
    expect(checkMatrixStructure(parse(doc), planScreen)).toHaveLength(0);
  });

  it("still fires on a PACKAGED free-paint document with no marker (non-regression pin)", () => {
    const findings = checkMatrixStructure(parse(packagedDoc(`<div>${listBody}</div>`)), planScreen);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "matrix-structure", severity: "major" });
    expect(findings[0]?.message).toMatch(/no data-matrix table/i);
  });
});

/**
 * The run-4 misfire, captured as a fixture (not the eval-output files). A combined "Desserts &
 * Beverages" board that shares no base dish must NOT carry matrix data after expansion, so the
 * matrix-structure check stays silent when the painter renders it as a plain list. Before Fix 1,
 * coverage attached a degenerate matrix and this same DOM tripped "no data-matrix table rendered".
 */
describe("checkMatrixStructure + coverage (Fix 1 — degenerate matrices never reach QA)", () => {
  const it_ = (id: string, name: string, category: string): CanonicalItem => ({
    id,
    name,
    category,
    available: true,
  });
  const menu: CanonicalItem[] = [
    it_("d1", "Gulab Jamun", "Desserts"),
    it_("d2", "Rasmalai", "Desserts"),
    it_("bev1", "Mango Lassi", "Beverages"),
    it_("bev2", "Masala Chai", "Beverages"),
  ];
  const layout: PlanLayout = {
    blocks: [
      {
        title: "Desserts & Beverages",
        categories: ["Desserts", "Beverages"],
        representation: "list",
        layoutHint: "",
      },
    ],
  };

  it("expands the degenerate combined board to sections WITHOUT matrix data", () => {
    const plan = expandLayoutToPlan(layout, menu, 1, { screensMode: "exact" });
    expect(plan.screens[0]!.sections.every((s) => s.matrix === undefined)).toBe(true);
  });

  it("stays silent on the plain-list DOM the painter renders for that board", () => {
    const screen = expandLayoutToPlan(layout, menu, 1, { screensMode: "exact" }).screens[0]!;
    const listHtml = `<div>${menu
      .map((m) => `<article data-item-id="${m.id}"><span data-bind="price">$5.00</span></article>`)
      .join("")}</div>`;
    expect(checkMatrixStructure(parse(listHtml), screen)).toHaveLength(0);
  });
});
