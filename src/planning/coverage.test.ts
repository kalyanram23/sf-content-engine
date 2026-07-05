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

  it("caps boards at the section count when boards outnumber sections (atomic, D25)", () => {
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
    const warnings: string[] = [];
    // One section cannot split across 2 boards — the count lowers to 1, with a warning.
    const plan = expandLayoutToPlan(single, MENU, 2, {
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(plan.screens).toHaveLength(1);
    expect(warnings.some((w) => /atomic/i.test(w))).toBe(true);
    const placed = plan.screens.flatMap((s) => s.sections.flatMap((sec) => sec.items));
    expect(new Set(placed)).toEqual(new Set(MENU.map((i) => i.id)));
    expect(placed).toHaveLength(MENU.length);
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

describe("imageSlot synthesis (matrix shared hero)", () => {
  it("gives a matrix board an imageSlot cycling its photo items", () => {
    const plan = expandLayoutToPlan(LAYOUT, MENU, 2);
    const matrixScreen = plan.screens.find((s) =>
      s.sections.some((sec) => sec.representation === "matrix"),
    );
    expect(matrixScreen?.imageSlot).toBeDefined();
    // b1, b2, p1 carry photos in MENU; p2 does not.
    expect(matrixScreen?.imageSlot?.items).toEqual(["b1", "b2", "p1"]);
  });

  it("anchors a comfortable, spare non-matrix board's slot to its dominant photo category (D33)", () => {
    const plan = expandLayoutToPlan(LAYOUT, MENU, 2);
    const gridScreen = plan.screens.find(
      (s) => !s.sections.some((sec) => sec.representation === "matrix"),
    );
    expect(gridScreen).toBeDefined();
    // Veg Curries v1/v2 carry photos (Desserts d1/d2 don't) — the slot is anchored to that category,
    // NOT a free-floating hero. (Was slot-less before D33; the sparse board wasted the space.)
    expect(gridScreen?.imageSlot?.categoryId).toBe("Veg Curries");
    expect(gridScreen?.imageSlot?.items).toEqual(["v1", "v2"]);
  });

  it("synthesizes a slot for a table board flagged only by layoutHint (not representation)", () => {
    const menu: CanonicalItem[] = [
      item("b1", "Chicken Biryani", "Biryani", true),
      item("b2", "Paneer Biryani", "Biryani", true),
    ];
    const plan = expandLayoutToPlan(
      {
        blocks: [
          {
            title: "Biryani",
            categories: ["Biryani"],
            // representation is grid, but the layoutHint marks it a price table.
            representation: "grid",
            layoutHint: "price table: rows = base dish, columns = style",
          },
        ],
      },
      menu,
      1,
    );
    expect(plan.screens[0]?.imageSlot?.items).toEqual(["b1", "b2"]);
  });

  it("does not synthesize a slot when fewer than two matrix-board items have photos", () => {
    const sparse: CanonicalItem[] = [
      item("b1", "Chicken Biryani", "Biryani", true),
      item("b2", "Paneer Biryani", "Biryani"),
    ];
    const plan = expandLayoutToPlan(
      {
        blocks: [
          { title: "Biryani", categories: ["Biryani"], representation: "matrix", layoutHint: "" },
        ],
      },
      sparse,
      1,
    );
    expect(plan.screens[0]?.imageSlot).toBeUndefined();
  });
});

describe("comfortable image-slot guarantee (D33)", () => {
  // `n` items in one non-matrix (grid) category, the first `withPhotos` of them carrying a photo.
  const photoMenu = (n: number, withPhotos: number, category = "Small Plates"): CanonicalItem[] =>
    Array.from({ length: n }, (_, i) => item(`s${i}`, `Dish ${i}`, category, i < withPhotos));
  const gridLayout = (category = "Small Plates"): PlanLayout => ({
    blocks: [{ title: category, categories: [category], representation: "grid", layoutHint: "" }],
  });

  it("populates a category-anchored slot for a comfortable, spare board with photos", () => {
    const plan = expandLayoutToPlan(gridLayout(), photoMenu(3, 3), 1, { screensMode: "exact" });
    const screen = plan.screens[0]!;
    expect(screen.densityTier).toBe("comfortable");
    expect(screen.imageSlot?.categoryId).toBe("Small Plates");
    expect(screen.imageSlot?.items).toEqual(["s0", "s1", "s2"]);
  });

  it("fires for a single-photo board too (a static panel still fills the empty space)", () => {
    const plan = expandLayoutToPlan(gridLayout(), photoMenu(3, 1), 1, { screensMode: "exact" });
    expect(plan.screens[0]!.imageSlot?.items).toEqual(["s0"]);
  });

  it("leaves a comfortable board with no photos slot-less (nothing to show)", () => {
    const plan = expandLayoutToPlan(gridLayout(), photoMenu(3, 0), 1, { screensMode: "exact" });
    expect(plan.screens[0]!.densityTier).toBe("comfortable");
    expect(plan.screens[0]!.imageSlot).toBeUndefined();
  });

  it("never fires on a dense/packed board, even with photos (photos are suppressed there, D30)", () => {
    const plan = expandLayoutToPlan(gridLayout(), photoMenu(30, 30), 1, {
      legibilityBudget: 10,
      screensMode: "exact",
    });
    expect(plan.screens[0]!.densityTier).not.toBe("comfortable");
    expect(plan.screens[0]!.imageSlot).toBeUndefined();
  });

  it("stays conservative — no slot when a comfortable board is already nearly full", () => {
    // 9 rows on a 10-row budget: comfortable, but 9*2 > 10 → not clearly spare → no slot forced.
    const plan = expandLayoutToPlan(gridLayout(), photoMenu(9, 9), 1, {
      legibilityBudget: 10,
      screensMode: "exact",
    });
    expect(plan.screens[0]!.densityTier).toBe("comfortable");
    expect(plan.screens[0]!.imageSlot).toBeUndefined();
  });

  it("leaves an existing (matrix) slot untouched — does not stack a comfortable slot on top", () => {
    // A small matrix board is comfortable + spare, but synthesizeImageSlot already supplied the
    // shared-hero slot; the comfortable path must not override it (categoryId stays unset — the
    // caption falls back to the combined section title).
    const menu: CanonicalItem[] = [
      item("b1", "Chicken Biryani", "Biryani", true),
      item("b2", "Paneer Biryani", "Biryani", true),
      item("p1", "Chicken Pulav", "Pulav", true),
    ];
    const plan = expandLayoutToPlan(
      {
        blocks: [
          {
            title: "Biryani & Pulav",
            categories: ["Biryani", "Pulav"],
            representation: "matrix",
            layoutHint: "price table",
          },
        ],
      },
      menu,
      1,
      { screensMode: "exact" },
    );
    const slot = plan.screens[0]!.imageSlot;
    expect(slot?.items).toEqual(["b1", "b2", "p1"]);
    expect(slot?.categoryId).toBeUndefined();
  });
});

/** One list block per category (each its own atomic section). */
const listLayoutOf = (categories: readonly string[]): PlanLayout => ({
  blocks: categories.map((c) => ({
    title: c,
    categories: [c],
    representation: "list" as const,
    layoutHint: "",
  })),
});

/** `total` items spread evenly (in order) across the given categories. */
const menuAcross = (total: number, categories: readonly string[]): CanonicalItem[] => {
  const per = Math.ceil(total / categories.length);
  return Array.from({ length: total }, (_, i) =>
    item(`x${i}`, `Dish ${i}`, categories[Math.floor(i / per)]!),
  );
};

describe("elastic screen count (§ Phase 3)", () => {
  const listLayout = (category: string): PlanLayout => listLayoutOf([category]);
  const menuOf = (n: number, category = "Curries"): CanonicalItem[] =>
    Array.from({ length: n }, (_, i) => item(`x${i}`, `Dish ${i}`, category));

  it("RAISES the board count to fit when the request would overflow the budget", () => {
    const warnings: string[] = [];
    // 30 list items (2 sections) over a budget of 24/board cannot fit 1 board → raise to the
    // arithmetic minimum (sections are atomic, so the raise needs ≥2 sections to land on).
    const plan = expandLayoutToPlan(listLayoutOf(["A", "B"]), menuAcross(30, ["A", "B"]), 1, {
      legibilityBudget: 24,
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(plan.screens.length).toBe(Math.ceil(30 / 24)); // 2
    expect(warnings.some((w) => /raising/i.test(w))).toBe(true);
    const placed = plan.screens.flatMap((s) => s.sections.flatMap((sec) => sec.items));
    expect(placed).toHaveLength(30);
  });

  it("LOWERS the board count when the request would leave sparse boards", () => {
    const warnings: string[] = [];
    // 8 items requested as 6 boards → ~1.3/board, well below the floor of 4 → shrink.
    const plan = expandLayoutToPlan(listLayoutOf(["A", "B"]), menuAcross(8, ["A", "B"]), 6, {
      legibilityBudget: 24,
      minItemsPerBoard: 4,
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(plan.screens.length).toBe(2); // floor(8 / 4)
    expect(warnings.some((w) => /lowering/i.test(w))).toBe(true);
    const placed = plan.screens.flatMap((s) => s.sections.flatMap((sec) => sec.items));
    expect(placed).toHaveLength(8);
  });

  it("never drops below 1 board even for a tiny menu", () => {
    const plan = expandLayoutToPlan(listLayout("Curries"), menuOf(2), 6, { minItemsPerBoard: 4 });
    expect(plan.screens).toHaveLength(1);
  });

  it("grows a huge menu (241 items / 6 requested) toward the fit minimum (~11 boards)", () => {
    // 12 categories so the raised count has enough atomic sections to land on.
    const categories = Array.from({ length: 12 }, (_, i) => `Cat ${i}`);
    const plan = expandLayoutToPlan(listLayoutOf(categories), menuAcross(241, categories), 6, {
      legibilityBudget: 24,
    });
    expect(plan.screens.length).toBe(Math.ceil(241 / 24)); // 11
    const placed = plan.screens.flatMap((s) => s.sections.flatMap((sec) => sec.items));
    expect(placed).toHaveLength(241);
  });

  it("weights a matrix section by ROWS, not items, when fitting boards", () => {
    // 12 base dishes each present in BOTH columns = 24 items but only 12 rows. With a budget of 12
    // and floor 1, the row weight (12) fits ONE board; an item-weighted planner (24) would split it.
    const rows = 12;
    const biryani = Array.from({ length: rows }, (_, i) =>
      item(`b${i}`, `Dish ${i} Biryani`, "Biryani"),
    );
    const pulav = Array.from({ length: rows }, (_, i) => item(`p${i}`, `Dish ${i} Pulav`, "Pulav"));
    const layout: PlanLayout = {
      blocks: [
        {
          title: "Biryani & Pulav",
          categories: ["Biryani", "Pulav"],
          representation: "matrix",
          layoutHint: "price table",
        },
      ],
    };
    const plan = expandLayoutToPlan(layout, [...biryani, ...pulav], 1, {
      legibilityBudget: 12,
      minItemsPerBoard: 1,
    });
    expect(plan.screens).toHaveLength(1);
    const section = plan.screens[0]!.sections[0]!;
    expect(section.matrix?.rows).toHaveLength(rows);
    const placed = plan.screens.flatMap((s) => s.sections.flatMap((sec) => sec.items));
    expect(placed).toHaveLength(rows * 2);
  });
});

describe("category atomicity (D25) — a category never spans two screens", () => {
  const matrixMenu = (rows: number): CanonicalItem[] => [
    ...Array.from({ length: rows }, (_, i) => item(`b${i}`, `Dish ${i} Biryani`, "Biryani")),
    ...Array.from({ length: rows }, (_, i) => item(`p${i}`, `Dish ${i} Pulav`, "Pulav")),
  ];
  const matrixLayout: PlanLayout = {
    blocks: [
      {
        title: "Biryani & Pulav",
        categories: ["Biryani", "Pulav"],
        representation: "matrix",
        layoutHint: "price table",
      },
    ],
  };

  it("keeps a 26-row matrix as ONE section with ONE title on ONE screen (never split)", () => {
    const warnings: string[] = [];
    // 26 rows exceed the 24-row budget — the old splitOversizedMatrices made "(1)"/"(2)" halves.
    const plan = expandLayoutToPlan(matrixLayout, matrixMenu(26), 1, {
      legibilityBudget: 24,
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(plan.screens).toHaveLength(1);
    expect(plan.screens[0]!.sections).toHaveLength(1);
    const section = plan.screens[0]!.sections[0]!;
    // ONE title, verbatim — no "(1)"/"(2)" suffix machinery.
    expect(section.title).toBe("Biryani & Pulav");
    expect(section.matrix?.rows).toHaveLength(26);
    // The dense board is the intended SIGNAL now: warned, never split.
    expect(warnings.some((w) => /dense/i.test(w))).toBe(true);
    const placed = plan.screens.flatMap((s) => s.sections.flatMap((sec) => sec.items));
    expect(placed).toHaveLength(52);
  });

  it("no plan section title ever carries a split suffix, and boards never exceed sections", () => {
    // A tall matrix + a long list, budget 10 — everything that used to trigger splitting.
    const categories = ["Biryani", "Pulav"];
    const menu = [...matrixMenu(30), ...menuAcross(20, ["Curries"])];
    const layout: PlanLayout = {
      blocks: [
        ...matrixLayout.blocks,
        { title: "Curries", categories: ["Curries"], representation: "list", layoutHint: "" },
      ],
    };
    const plan = expandLayoutToPlan(layout, menu, 6, {
      legibilityBudget: 10,
      minItemsPerBoard: 1,
    });
    // 2 sections → at most 2 boards, whatever the request/budget said.
    expect(plan.screens.length).toBeLessThanOrEqual(2);
    for (const screen of plan.screens) {
      for (const section of screen.sections) {
        expect(section.title).not.toMatch(/\(\d+\)$/);
      }
    }
    // Matrix rows always carry BOTH cells — a row's cells never travel apart.
    const matrixSection = plan.screens
      .flatMap((s) => s.sections)
      .find((s) => s.matrix !== undefined);
    expect(matrixSection?.matrix?.rows).toHaveLength(30);
    for (const row of matrixSection!.matrix!.rows)
      expect(row.cells).toHaveLength(categories.length);
    const placed = plan.screens.flatMap((s) => s.sections.flatMap((sec) => sec.items));
    expect(placed).toHaveLength(80);
  });
});

describe("exact screens mode (D26)", () => {
  it("honours the requested count exactly — no elastic lowering of sparse boards", () => {
    // 6 items across 3 categories: elastic would lower 3 boards to 1 (floor(6/4)); exact keeps 3.
    const categories = ["A", "B", "C"];
    const plan = expandLayoutToPlan(listLayoutOf(categories), menuAcross(6, categories), 3, {
      minItemsPerBoard: 4,
      screensMode: "exact",
    });
    expect(plan.screens).toHaveLength(3);
  });

  it("honours the requested count exactly — no elastic raising for over-budget content", () => {
    const warnings: string[] = [];
    // 240 items across 8 categories over a 24 budget: elastic would raise toward 10; exact keeps 6
    // and the dense boards WARN instead (the D26 over-budget regime handles the layout).
    const categories = Array.from({ length: 8 }, (_, i) => `Cat ${i}`);
    const plan = expandLayoutToPlan(listLayoutOf(categories), menuAcross(240, categories), 6, {
      legibilityBudget: 24,
      screensMode: "exact",
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(plan.screens).toHaveLength(6);
    expect(warnings.some((w) => /raising/i.test(w))).toBe(false);
    expect(warnings.some((w) => /dense/i.test(w))).toBe(true);
    const placed = plan.screens.flatMap((s) => s.sections.flatMap((sec) => sec.items));
    expect(placed).toHaveLength(240);
  });

  it("caps an exact request at the section count with a warning (atomicity wins)", () => {
    const warnings: string[] = [];
    const categories = ["A", "B", "C"];
    const plan = expandLayoutToPlan(listLayoutOf(categories), menuAcross(30, categories), 6, {
      screensMode: "exact",
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(plan.screens).toHaveLength(3);
    expect(warnings.some((w) => /atomic/i.test(w))).toBe(true);
  });

  it("elastic mode still flexes when screensMode is omitted (back-compat)", () => {
    // Same sparse input as the exact test above: default (elastic) lowers 3 → 1.
    const categories = ["A", "B", "C"];
    const plan = expandLayoutToPlan(listLayoutOf(categories), menuAcross(6, categories), 3, {
      minItemsPerBoard: 4,
    });
    expect(plan.screens).toHaveLength(1);
  });
});

describe("density tier stamping (D30)", () => {
  const oneCategory = (n: number): CanonicalItem[] =>
    Array.from({ length: n }, (_, i) => item(`x${i}`, `Dish ${i}`, "Curries"));
  const listLayout: PlanLayout = {
    blocks: [{ title: "Curries", categories: ["Curries"], representation: "list", layoutHint: "" }],
  };
  // Pin the whole menu onto ONE board (exact mode, 1 screen) so the board weight == item count.
  const tierOf = (n: number, opts: Record<string, unknown>) =>
    expandLayoutToPlan(listLayout, oneCategory(n), 1, { screensMode: "exact", ...opts }).screens[0]!
      .densityTier;

  it("stamps a tier on every screen", () => {
    const plan = expandLayoutToPlan(LAYOUT, MENU, 2);
    expect(plan.screens.every((s) => s.densityTier !== undefined)).toBe(true);
  });

  it("is comfortable at/under the budget and dense just over it (budget edge)", () => {
    expect(tierOf(10, { legibilityBudget: 10 })).toBe("comfortable");
    expect(tierOf(11, { legibilityBudget: 10 })).toBe("dense");
  });

  it("is dense up to packedMultiplier×budget and packed beyond it (2× edge)", () => {
    expect(tierOf(20, { legibilityBudget: 10 })).toBe("dense"); // == 2×budget
    expect(tierOf(21, { legibilityBudget: 10 })).toBe("packed"); // > 2×budget
  });

  it("honours a custom packedMultiplier", () => {
    expect(tierOf(30, { legibilityBudget: 10, packedMultiplier: 3 })).toBe("dense"); // == 3×
    expect(tierOf(31, { legibilityBudget: 10, packedMultiplier: 3 })).toBe("packed");
  });

  it("names the tier in the dense-board warning", () => {
    const warnings: string[] = [];
    tierOf(30, { legibilityBudget: 10, logger: { warn: (m: string) => warnings.push(m) } });
    expect(warnings.some((w) => /\(packed\)/.test(w))).toBe(true);
  });
});
