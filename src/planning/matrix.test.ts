import { describe, expect, it } from "vitest";

import type { CanonicalItem, SectionMatrix } from "../domain/types";
import { buildMatrix, matrixItemIds } from "./matrix";

function item(id: string, name: string, category: string): CanonicalItem {
  return { id, name, category, available: true };
}

/** Group a flat item list by category (menu order), as coverage does before buildMatrix. */
function group(items: CanonicalItem[]): Map<string, CanonicalItem[]> {
  const map = new Map<string, CanonicalItem[]>();
  for (const it of items) {
    const bucket = map.get(it.category ?? "?");
    if (bucket) bucket.push(it);
    else map.set(it.category ?? "?", [it]);
  }
  return map;
}

/** Look up a row by its label; asserts it exists. */
function row(matrix: SectionMatrix, label: string): SectionMatrix["rows"][number] {
  const r = matrix.rows.find((row) => row.label === label);
  expect(r, `row "${label}" should exist`).toBeDefined();
  return r!;
}

describe("buildMatrix — cross-category base-dish pairing (realistic menu names)", () => {
  const biryani = [
    item("b-chicken-dum", "Chicken Dum Biryani *", "Biryani"),
    item("b-chicken-65", "Chicken 65 Biryani", "Biryani"),
    item("b-mutton-ghee", "Mutton Ghee Roast Biryani *", "Biryani"),
    item("b-paneer", "Paneer Biryani", "Biryani"),
    item("b-pachi-chicken", "Pachi Mirchi Chicken Biryani", "Biryani"),
  ];
  const pulav = [
    item("p-mutton-ghee", "Mutton Ghee Roast Pulav *", "Pulav"),
    item("p-pachi-chicken", "Pachi Mirchi Chicken Pulav *", "Pulav"),
    item("p-paneer", "Paneer Pulav", "Pulav"),
  ];
  const matrix = buildMatrix(["Biryani", "Pulav"], group([...biryani, ...pulav]));

  it("keeps the columns in block order", () => {
    expect(matrix.columns).toEqual(["Biryani", "Pulav"]);
  });

  it("pairs items across columns by their base dish", () => {
    expect(row(matrix, "Mutton Ghee Roast").cells).toEqual(["b-mutton-ghee", "p-mutton-ghee"]);
    expect(row(matrix, "Pachi Mirchi Chicken").cells).toEqual([
      "b-pachi-chicken",
      "p-pachi-chicken",
    ]);
    expect(row(matrix, "Paneer").cells).toEqual(["b-paneer", "p-paneer"]);
  });

  it("leaves a null cell (em-dash) where a column has no match", () => {
    expect(row(matrix, "Chicken Dum").cells).toEqual(["b-chicken-dum", null]);
    expect(row(matrix, "Chicken 65").cells).toEqual(["b-chicken-65", null]);
  });

  it("places every item in exactly one cell (coverage invariant)", () => {
    const ids = matrixItemIds(matrix);
    expect(new Set(ids)).toEqual(new Set([...biryani, ...pulav].map((i) => i.id)));
    expect(ids).toHaveLength(biryani.length + pulav.length);
  });
});

describe("buildMatrix — collisions never merge or drop", () => {
  it("keeps two same-category items with the same base as separate rows", () => {
    const items = [
      item("b1", "Paneer Biryani", "Biryani"),
      item("b2", "Paneer Biryani *", "Biryani"), // normalises to the same base as b1
      item("p1", "Paneer Pulav", "Pulav"),
    ];
    const matrix = buildMatrix(["Biryani", "Pulav"], group(items));
    // b1 and b2 must be on DIFFERENT rows (not merged into one Biryani cell).
    const biryaniCells = matrix.rows.map((r) => r.cells[0]).filter((c) => c !== null);
    expect(biryaniCells).toHaveLength(2);
    expect(new Set(biryaniCells)).toEqual(new Set(["b1", "b2"]));
    // Nothing dropped: all three ids present exactly once.
    expect(matrixItemIds(matrix).sort()).toEqual(["b1", "b2", "p1"]);
    // The collision row is disambiguated by its full name.
    expect(matrix.rows.some((r) => r.label === "Paneer Biryani *".replace(/\s*\*+\s*$/, ""))).toBe(
      true,
    );
  });
});

describe("buildMatrix — empty-remainder fallback", () => {
  it("falls back to the full name when the name is only the category word", () => {
    const items = [item("b1", "Biryani", "Biryani"), item("p1", "Veg Pulav", "Pulav")];
    const matrix = buildMatrix(["Biryani", "Pulav"], group(items));
    // "Biryani" minus its category token is empty → label falls back to the full name.
    expect(row(matrix, "Biryani").cells[0]).toBe("b1");
    expect(matrixItemIds(matrix).sort()).toEqual(["b1", "p1"]);
  });

  it("removes multi-word category tokens (e.g. 'Special Rice')", () => {
    const items = [item("r1", "Jeera Special Rice", "Special Rice")];
    const matrix = buildMatrix(["Special Rice"], group(items));
    expect(matrix.rows[0]!.label).toBe("Jeera");
    expect(matrix.rows[0]!.cells).toEqual(["r1"]);
  });
});

// NOTE: `splitMatrixRows` and its tests were removed with D25 — categories (and their matrices)
// are atomic and never split across screens.
