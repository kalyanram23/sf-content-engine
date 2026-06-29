import { describe, expect, it } from "vitest";

import type { PlanLayout } from "../domain/contracts";
import type { CanonicalItem } from "../domain/types";
import { buildMenuDigest, expandLayoutToPlan, partitionContiguous } from "./coverage";

function item(id: string, name: string, category: string, photo = false): CanonicalItem {
  return {
    id,
    name,
    category,
    available: true,
    ...(photo ? { images: [`https://example.test/${id}.jpg`] } : {}),
  };
}

const MENU: CanonicalItem[] = [
  item("b1", "Chicken Biryani", "Biryani", true),
  item("b2", "Paneer Biryani", "Biryani", true),
  item("p1", "Chicken Pulav", "Pulav", true),
  item("p2", "Paneer Pulav", "Pulav"),
  item("v1", "Mix Veg Curry", "Veg Curries", true),
  item("v2", "Kaju Paneer", "Veg Curries", true),
  item("v3", "Malai Kofta", "Veg Curries"),
  item("d1", "Gulab Jamun", "Desserts"),
  item("d2", "Rasmalai", "Desserts"),
];

const LAYOUT: PlanLayout = {
  blocks: [
    {
      title: "Biryani & Pulav",
      categories: ["Biryani", "Pulav"],
      representation: "matrix",
      layoutHint: "price table: rows = base dish, columns = Biryani | Pulav",
    },
    { title: "Veg Curries", categories: ["Veg Curries"], representation: "grid", layoutHint: "" },
    // NOTE: "Desserts" is intentionally omitted — the expander must still place it.
  ],
};

describe("expandLayoutToPlan", () => {
  it("places every menu item across exactly the requested number of boards", () => {
    const plan = expandLayoutToPlan(LAYOUT, MENU, 2);
    expect(plan.screens).toHaveLength(2);
    const placed = plan.screens.flatMap((s) => s.sections.flatMap((sec) => sec.items));
    expect(new Set(placed)).toEqual(new Set(MENU.map((i) => i.id)));
    // no item placed twice
    expect(placed).toHaveLength(MENU.length);
  });

  it("carries the LLM block's representation, title, and layoutHint", () => {
    const plan = expandLayoutToPlan(LAYOUT, MENU, 2);
    const combined = plan.screens
      .flatMap((s) => s.sections)
      .find((sec) => sec.title === "Biryani & Pulav");
    expect(combined).toBeDefined();
    expect(combined?.representation).toBe("matrix");
    expect(combined?.layoutHint).toContain("price table");
    // combined section holds all biryani + pulav items
    expect(new Set(combined?.items)).toEqual(new Set(["b1", "b2", "p1", "p2"]));
  });

  it("appends a section for a category the planner omitted (no silent drop)", () => {
    const plan = expandLayoutToPlan(LAYOUT, MENU, 2);
    const desserts = plan.screens
      .flatMap((s) => s.sections)
      .find((sec) => sec.title === "Desserts");
    expect(desserts).toBeDefined();
    expect(new Set(desserts?.items)).toEqual(new Set(["d1", "d2"]));
  });

  it("keeps a category referenced by two blocks only once (no duplicate bindings)", () => {
    const dupLayout: PlanLayout = {
      blocks: [
        { title: "A", categories: ["Biryani"], representation: "grid", layoutHint: "" },
        { title: "B", categories: ["Biryani"], representation: "list", layoutHint: "" },
        {
          title: "Rest",
          categories: ["Pulav", "Veg Curries", "Desserts"],
          representation: "list",
          layoutHint: "",
        },
      ],
    };
    const plan = expandLayoutToPlan(dupLayout, MENU, 2);
    const placed = plan.screens.flatMap((s) => s.sections.flatMap((sec) => sec.items));
    expect(placed.filter((id) => id === "b1")).toHaveLength(1);
    expect(placed).toHaveLength(MENU.length);
  });

  it("splits sections when boards outnumber categories", () => {
    const single: PlanLayout = {
      blocks: [
        {
          title: "Everything",
          categories: ["Biryani", "Pulav", "Veg Curries", "Desserts"],
          representation: "list",
          layoutHint: "",
        },
      ],
    };
    const plan = expandLayoutToPlan(single, MENU, 3);
    expect(plan.screens).toHaveLength(3);
    const placed = plan.screens.flatMap((s) => s.sections.flatMap((sec) => sec.items));
    expect(new Set(placed)).toEqual(new Set(MENU.map((i) => i.id)));
  });

  it("throws only when the layout is structurally empty", () => {
    expect(() =>
      expandLayoutToPlan(
        {
          blocks: [
            { title: "x", categories: ["Nonexistent"], representation: "grid", layoutHint: "" },
          ],
        },
        [],
        1,
      ),
    ).toThrow();
  });
});

describe("partitionContiguous", () => {
  it("balances equal sizes evenly", () => {
    expect(partitionContiguous([10, 10, 10, 10], 2)).toEqual([2, 2]);
  });

  it("isolates a heavy section to minimise the busiest board", () => {
    expect(partitionContiguous([1, 1, 1, 10], 2)).toEqual([3, 1]);
  });

  it("returns one group when k=1 and one-per-group when k=n", () => {
    expect(partitionContiguous([5, 3, 2], 1)).toEqual([3]);
    expect(partitionContiguous([5, 3, 2], 3)).toEqual([1, 1, 1]);
  });
});

describe("buildMenuDigest", () => {
  it("summarises by category with counts, photo counts, and sample names", () => {
    const digest = buildMenuDigest(MENU, 5);
    const biryani = digest.find((d) => d.category === "Biryani");
    expect(biryani).toEqual({
      category: "Biryani",
      count: 2,
      withPhotos: 2,
      sampleNames: ["Chicken Biryani", "Paneer Biryani"],
    });
    // menu order preserved
    expect(digest.map((d) => d.category)).toEqual(["Biryani", "Pulav", "Veg Curries", "Desserts"]);
  });
});

describe("legibility warning (warn-and-cram)", () => {
  it("warns but does not throw when a board exceeds the ~10–20 ft budget", () => {
    const big: CanonicalItem[] = Array.from({ length: 30 }, (_, i) =>
      item(`x${i}`, `Dish ${i}`, "Curries"),
    );
    const warnings: string[] = [];
    const plan = expandLayoutToPlan(
      {
        blocks: [
          { title: "Curries", categories: ["Curries"], representation: "list", layoutHint: "" },
        ],
      },
      big,
      1,
      { warn: (m) => warnings.push(m) },
    );
    expect(plan.screens).toHaveLength(1);
    expect(warnings.some((w) => w.includes("30 items"))).toBe(true);
  });
});
