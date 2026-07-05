import { describe, expect, it } from "vitest";

import { defaultLayoutsConfig } from "../config/layouts";
import type { CanonicalItem, PlanScreen } from "../domain/types";
import {
  MATRIX_FIRST_STRATEGY,
  PHOTO_LED_GRID_STRATEGY,
  describeLayoutStrategy,
  mergeBlueprints,
  renderBlueprintStrategy,
  renderMatrixSummary,
  selectBlueprint,
} from "./layout-strategy";

const layouts = defaultLayoutsConfig();

function item(id: string, photo = false): CanonicalItem {
  return {
    id,
    name: id,
    category: "c",
    available: true,
    ...(photo ? { images: [`https://x/${id}.jpg`] } : {}),
  };
}

function board(
  representation: PlanScreen["sections"][number]["representation"],
  n: number,
): PlanScreen {
  return {
    id: "s1",
    sections: [{ title: "T", representation, items: Array.from({ length: n }, (_, i) => `i${i}`) }],
  };
}

describe("selectBlueprint — regression parity with the legacy binary", () => {
  const items = Array.from({ length: 12 }, (_, i) => item(`i${i}`, true));

  it("a matrix board selects matrix-first with the verbatim legacy strategy", () => {
    const bp = selectBlueprint(board("matrix", 6), items, layouts.blueprints);
    expect(bp.id).toBe("matrix-first");
    expect(bp.strategy).toBe(MATRIX_FIRST_STRATEGY);
  });

  it("a board whose layoutHint mentions a table selects matrix-first", () => {
    const b: PlanScreen = {
      id: "s1",
      sections: [
        { title: "T", representation: "grid", items: ["i0"], layoutHint: "a price table x/y" },
      ],
    };
    expect(selectBlueprint(b, items, layouts.blueprints).id).toBe("matrix-first");
  });

  it("a large list board selects the type-led price ladder", () => {
    expect(selectBlueprint(board("list", 12), items, layouts.blueprints).id).toBe("price-ladder");
  });

  it("a small photo grid board selects hero-split", () => {
    const b = board("grid", 3);
    expect(selectBlueprint(b, items, layouts.blueprints).id).toBe("hero-split");
  });

  it("falls back to photo-led-grid (verbatim legacy strategy) when nothing niche matches", () => {
    // A single-section grid of 3 items with NO photos: hero-split needs a photo, three-up needs 5+.
    const noPhotos = Array.from({ length: 3 }, (_, i) => item(`i${i}`));
    const bp = selectBlueprint(board("grid", 3), noPhotos, layouts.blueprints);
    expect(bp.id).toBe("photo-led-grid");
    expect(bp.strategy).toBe(PHOTO_LED_GRID_STRATEGY);
  });

  it("is deterministic (priority desc, id asc) and always returns a blueprint", () => {
    const a = selectBlueprint(
      board("grid", 8),
      Array.from({ length: 8 }, (_, i) => item(`i${i}`, true)),
      layouts.blueprints,
    );
    const b = selectBlueprint(
      board("grid", 8),
      Array.from({ length: 8 }, (_, i) => item(`i${i}`, true)),
      layouts.blueprints,
    );
    expect(a.id).toBe(b.id);
  });

  it("returns a synthetic fallback when the catalog has no catch-all", () => {
    const onlyMatrix = layouts.blueprints.filter((b) => b.id === "matrix-first");
    const bp = selectBlueprint(board("grid", 2), [], onlyMatrix);
    expect(bp.id).toBe("legacy-fallback");
    expect(bp.strategy).toBe(describeLayoutStrategy(board("grid", 2)));
  });
});

describe("mergeBlueprints", () => {
  it("overrides a catalog blueprint by id and appends new ones", () => {
    const merged = mergeBlueprints(layouts.blueprints, [
      {
        id: "matrix-first",
        priority: 5,
        appliesWhen: {},
        strategy: "OVERRIDDEN",
        fixed: [],
        free: [],
      },
      { id: "custom", priority: 200, appliesWhen: {}, strategy: "CUSTOM", fixed: [], free: [] },
    ]);
    expect(merged.find((b) => b.id === "matrix-first")?.strategy).toBe("OVERRIDDEN");
    expect(merged.find((b) => b.id === "custom")).toBeDefined();
  });
});

describe("renderMatrixSummary — the shared painter/critic matrix text", () => {
  const items: CanonicalItem[] = [
    { id: "b1", name: "Chicken Biryani", category: "Biryani", available: true, price: 12 },
    { id: "b2", name: "Egg Biryani", category: "Biryani", available: true, price: 10 },
    { id: "p1", name: "Chicken Pulav", category: "Pulav", available: true, price: 11 },
  ];
  const screen: PlanScreen = {
    id: "s1",
    sections: [
      {
        title: "Biryani & Pulav",
        representation: "matrix",
        items: ["b1", "b2", "p1"],
        matrix: {
          columns: ["Biryani", "Pulav"],
          rows: [
            { label: "Chicken", cells: ["b1", "p1"] },
            { label: "Egg", cells: ["b2", null] },
          ],
        },
      },
    ],
  };

  it("renders columns, per-row prices/ids, and an em-dash for null cells", () => {
    const text = renderMatrixSummary(screen, items)!;
    expect(text).toContain("Columns left→right: Biryani | Pulav");
    expect(text).toContain("- Chicken | $12.00 (b1) | $11.00 (p1)");
    expect(text).toContain("- Egg | $10.00 (b2) | —");
  });

  it("returns undefined for a board with no matrix section", () => {
    expect(renderMatrixSummary(board("grid", 3), items)).toBeUndefined();
  });
});

describe("renderBlueprintStrategy", () => {
  it("renders strategy + FIXED + FREE blocks", () => {
    const s = renderBlueprintStrategy({
      id: "x",
      priority: 1,
      appliesWhen: {},
      strategy: "DO THIS",
      fixed: ["never drop items"],
      free: ["card order"],
    });
    expect(s).toContain("DO THIS");
    expect(s).toContain("FIXED (do not change):\n- never drop items");
    expect(s).toContain("FREE (your call):\n- card order");
  });
});
