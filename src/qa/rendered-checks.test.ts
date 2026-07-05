import { describe, expect, it } from "vitest";

import { defaultQaConfig } from "../config/qa";
import type { PlanScreen } from "../domain/types";
import type { RenderObservation } from "../ports/browser";
import {
  checkContrast,
  checkDensity,
  checkImageGeometry,
  checkImages,
  checkLegibility,
  checkOverflow,
  checkViewport,
  runRenderedChecks,
} from "./rendered-checks";
import type { ImageObservation } from "../ports/browser";

const qa = defaultQaConfig();

function baseObservation(overrides: Partial<RenderObservation> = {}): RenderObservation {
  return {
    actualViewport: { width: 1920, height: 1080, dpr: 1 },
    scroll: { scrollWidth: 1920, scrollHeight: 1080, clientWidth: 1920, clientHeight: 1080 },
    overflowing: [],
    textSamples: [
      {
        ref: "title",
        fg: { r: 0, g: 0, b: 0, a: 1 },
        bg: { r: 255, g: 255, b: 255, a: 1 },
        fontPx: 40,
        bold: true,
        bbox: { x: 0, y: 0, width: 100, height: 40 },
      },
    ],
    fillRatio: 0.6,
    images: [
      {
        ref: "hero",
        loaded: true,
        naturalWidth: 1200,
        naturalHeight: 800,
        renderedWidth: 600,
        renderedHeight: 400,
        objectFit: "cover",
      },
    ],
    ...overrides,
  };
}

describe("checkViewport", () => {
  it("passes when the rendered viewport matches the target", () => {
    expect(checkViewport(baseObservation(), qa.viewport)).toBeNull();
  });

  it("flags a DPR/size mismatch as a hard precondition failure", () => {
    const finding = checkViewport(
      baseObservation({ actualViewport: { width: 1920, height: 1080, dpr: 2 } }),
      qa.viewport,
    );
    expect(finding?.kind).toBe("viewport");
    expect(finding?.hardGate).toBe(true);
  });
});

describe("checkContrast", () => {
  it("passes legible text", () => {
    expect(checkContrast(baseObservation(), qa)).toHaveLength(0);
  });

  it("flags white-on-yellow as a hard-gate, deterministically-fixable finding", () => {
    const obs = baseObservation({
      textSamples: [
        {
          ref: "price",
          itemId: "id4",
          fg: { r: 255, g: 255, b: 255, a: 1 },
          bg: { r: 255, g: 255, b: 0, a: 1 },
          fontPx: 16,
          bold: false,
          bbox: { x: 0, y: 0, width: 50, height: 16 },
        },
      ],
    });
    const findings = checkContrast(obs, qa);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "contrast",
      hardGate: true,
      deterministicallyFixable: true,
      itemId: "id4",
    });
  });

  it("honours the relaxed large-text threshold", () => {
    // ratio ~3.x grey-on-white passes for large text but not normal text
    const grey = { r: 140, g: 140, b: 140, a: 1 };
    const white = { r: 255, g: 255, b: 255, a: 1 };
    const large = baseObservation({
      textSamples: [
        {
          ref: "t",
          fg: grey,
          bg: white,
          fontPx: 40,
          bold: false,
          bbox: { x: 0, y: 0, width: 1, height: 1 },
        },
      ],
    });
    const small = baseObservation({
      textSamples: [
        {
          ref: "t",
          fg: grey,
          bg: white,
          fontPx: 14,
          bold: false,
          bbox: { x: 0, y: 0, width: 1, height: 1 },
        },
      ],
    });
    expect(checkContrast(large, qa)).toHaveLength(0);
    expect(checkContrast(small, qa)).toHaveLength(1);
  });
});

describe("checkOverflow", () => {
  it("passes within tolerance and flags beyond it", () => {
    expect(checkOverflow(baseObservation(), qa)).toHaveLength(0);
    const overflowing = baseObservation({
      scroll: { scrollWidth: 1920, scrollHeight: 1300, clientWidth: 1920, clientHeight: 1080 },
    });
    const findings = checkOverflow(overflowing, qa);
    expect(findings[0]).toMatchObject({ kind: "overflow", tag: "layout" });
    expect(findings[0]?.data?.["overshootY"]).toBe(220);
  });

  it("marks a small overflow deterministically fixable + carries the fit factor (D31)", () => {
    // ~15% too tall → uniform fit ~0.869; no item-bound text, so no legibility floor binds.
    const obs = baseObservation({
      scroll: { scrollWidth: 1920, scrollHeight: 1242, clientWidth: 1920, clientHeight: 1080 },
    });
    const [finding] = checkOverflow(obs, qa);
    expect(finding?.deterministicallyFixable).toBe(true);
    expect(finding?.data?.["shrinkFactor"]).toBeCloseTo(0.869, 3);
  });

  it("declines to shrink when the fit factor would drop item text below the legibility floor (D31)", () => {
    // 2× too tall → fit 0.5; item price at 20px would render at 10px (< 14px floor) → NOT fixable.
    const obs = baseObservation({
      scroll: { scrollWidth: 1920, scrollHeight: 2160, clientWidth: 1920, clientHeight: 1080 },
      textSamples: [
        {
          ref: '[data-item-id="x"] [data-bind="price"]',
          itemId: "x",
          fg: { r: 0, g: 0, b: 0, a: 1 },
          bg: { r: 255, g: 255, b: 255, a: 1 },
          fontPx: 20,
          bold: false,
          bbox: { x: 0, y: 0, width: 1, height: 1 },
        },
      ],
    });
    const [finding] = checkOverflow(obs, qa);
    expect(finding?.kind).toBe("overflow");
    expect(finding?.deterministicallyFixable).toBe(false);
  });

  it("declines to shrink when the required fit is below the min-factor floor (D31)", () => {
    // 3× too tall → fit ~0.33 < minShrinkFactor 0.5: too aggressive to paper over → re-paint.
    const obs = baseObservation({
      scroll: { scrollWidth: 1920, scrollHeight: 3240, clientWidth: 1920, clientHeight: 1080 },
    });
    const [finding] = checkOverflow(obs, qa);
    expect(finding?.deterministicallyFixable).toBe(false);
  });
});

describe("checkDensity", () => {
  it("flags dead space (under-filled) — the spec acceptance #1 seed", () => {
    const findings = checkDensity(baseObservation({ fillRatio: 0.2 }), qa);
    expect(findings[0]).toMatchObject({ kind: "density", tag: "layout" });
    expect(findings[0]?.data?.["kind"]).toBe("under");
  });

  it("flags a crammed screen", () => {
    const findings = checkDensity(baseObservation({ fillRatio: 0.95 }), qa);
    expect(findings[0]?.data?.["kind"]).toBe("over");
  });

  it("passes a balanced screen", () => {
    expect(checkDensity(baseObservation({ fillRatio: 0.6 }), qa)).toHaveLength(0);
  });

  it("does NOT block a sparse type-led matrix board (§ Phase 5)", () => {
    const matrixBoard: PlanScreen = {
      id: "s",
      sections: [
        {
          title: "Biryani & Pulav",
          representation: "matrix",
          items: Array.from({ length: 20 }, (_, i) => `x${i}`), // not "sparse" by item count
          matrix: {
            columns: ["Biryani", "Pulav"],
            rows: [{ label: "Chicken", cells: ["x0", null] }],
          },
        },
      ],
    };
    // 30% fill would fail the 40% grid floor, but a table is type-led → held to the 20% floor.
    expect(checkDensity(baseObservation({ fillRatio: 0.3 }), qa, matrixBoard)).toHaveLength(0);
    // A photo-led grid board at the same fill still fails.
    const gridBoard: PlanScreen = {
      id: "s",
      sections: [
        {
          title: "Pizzas",
          representation: "grid",
          items: Array.from({ length: 20 }, (_, i) => `x${i}`),
        },
      ],
    };
    expect(checkDensity(baseObservation({ fillRatio: 0.3 }), qa, gridBoard)).toHaveLength(1);
  });

  it("still blocks an over-crammed type-led board (over-fill is universal)", () => {
    const matrixBoard: PlanScreen = {
      id: "s",
      sections: [
        {
          title: "T",
          representation: "matrix",
          items: ["x0"],
          matrix: { columns: ["A"], rows: [] },
        },
      ],
    };
    const findings = checkDensity(baseObservation({ fillRatio: 0.95 }), qa, matrixBoard);
    expect(findings[0]?.data?.["kind"]).toBe("over");
  });

  it("grades a PLAN-FORCED dense board's over-fill as a warning, not a major (D26)", () => {
    const board: PlanScreen = {
      id: "s",
      sections: [
        {
          title: "Curries",
          representation: "list",
          items: Array.from({ length: 34 }, (_, i) => `x${i}`),
        },
      ],
    };
    const obs = baseObservation({ fillRatio: 0.96 });
    // Same observation, same board: the sizing verdict decides the grade.
    const planForced = checkDensity(obs, qa, board, { overBudget: true });
    expect(planForced).toHaveLength(1);
    expect(planForced[0]).toMatchObject({ kind: "density", severity: "minor" });
    expect(planForced[0]?.data?.["planForced"]).toBe(true);
    expect(planForced[0]?.message).toMatch(/plan-forced/i);
    const within = checkDensity(obs, qa, board, { overBudget: false });
    expect(within[0]?.severity).toBe("major");
  });
});

describe("checkImages", () => {
  it("flags an unloaded gallery image", () => {
    const findings = checkImages(
      baseObservation({ images: [{ ref: "g1", loaded: false, naturalWidth: 0 }] }),
    );
    expect(findings[0]).toMatchObject({ kind: "image-slot", region: "g1" });
  });
});

describe("checkImageGeometry (§ Phase 4)", () => {
  const img = (over: Partial<ImageObservation>): ImageObservation => ({
    ref: "hero",
    loaded: true,
    naturalWidth: 1200,
    naturalHeight: 800, // 3:2
    renderedWidth: 600,
    renderedHeight: 400, // 3:2 → matches
    objectFit: "cover",
    ...over,
  });

  it("passes a well-proportioned cover photo", () => {
    expect(checkImageGeometry(baseObservation({ images: [img({})] }), qa)).toHaveLength(0);
  });

  it("flags a distorted fill image (aspect squished off natural)", () => {
    // 3:2 natural stretched into a 1:2 box under object-fit:fill.
    const findings = checkImageGeometry(
      baseObservation({
        images: [img({ objectFit: "fill", renderedWidth: 200, renderedHeight: 400 })],
      }),
      qa,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "image-distortion", severity: "major" });
  });

  it("flags an over-cropped cover photo (4:3 in a >3.5:1 band)", () => {
    // natural 4:3 (=1.333); band 1400×360 ≈ 3.9:1 → factor ≈ 2.9 > 2.2.
    const findings = checkImageGeometry(
      baseObservation({
        images: [
          img({
            naturalWidth: 1200,
            naturalHeight: 900,
            renderedWidth: 1400,
            renderedHeight: 360,
          }),
        ],
      }),
      qa,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "image-crop", severity: "major" });
  });

  it("skips images missing the geometry fields (backward compatible)", () => {
    const findings = checkImageGeometry(
      baseObservation({ images: [{ ref: "old", loaded: true, naturalWidth: 1200 }] }),
      qa,
    );
    expect(findings).toHaveLength(0);
  });

  it("skips 1×1 placeholder pixels — their 'aspect' is meaningless (no false crop findings)", () => {
    // The 1×1 transparent PNG fallback stretched into a wide band tripped image-crop on a real
    // run (container 3.03 vs natural 1.00). Defence in depth: never grade a placeholder's aspect.
    const findings = checkImageGeometry(
      baseObservation({
        images: [
          img({ naturalWidth: 1, naturalHeight: 1, renderedWidth: 1400, renderedHeight: 460 }),
        ],
      }),
      qa,
    );
    expect(findings).toHaveLength(0);
  });
});

describe("checkLegibility", () => {
  const itemSample = (fontPx: number, itemId = "i1") => ({
    ref: `[data-item-id="${itemId}"]`,
    itemId,
    fg: { r: 0, g: 0, b: 0, a: 1 },
    bg: { r: 255, g: 255, b: 255, a: 1 },
    fontPx,
    bold: false,
    bbox: { x: 0, y: 0, width: 100, height: 20 },
  });

  it("flags item text below the floor, aggregated into one finding", () => {
    const obs = baseObservation({ textSamples: [itemSample(11), itemSample(12, "i2")] });
    const findings = checkLegibility(obs, qa);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "legibility", severity: "major", tag: "layout" });
    expect(findings[0]?.data?.["count"]).toBe(2);
    // worst offender named in the message/region
    expect(findings[0]?.region).toBe('[data-item-id="i1"]');
  });

  it("ignores small text that is not item-bound (chrome/footnotes)", () => {
    const { itemId: _itemId, ...chrome } = itemSample(10);
    const obs = baseObservation({ textSamples: [{ ...chrome, ref: "footer" }] });
    expect(checkLegibility(obs, qa)).toHaveLength(0);
  });

  it("relaxes the floor for items in a matrix section", () => {
    const obs = baseObservation({ textSamples: [itemSample(13, "m1")] });
    const matrixPlan = {
      id: "s1",
      sections: [{ title: "T", representation: "matrix" as const, items: ["m1"] }],
    };
    // 13px fails the default 14px item floor, but passes the 12px matrix floor.
    expect(checkLegibility(obs, qa)).toHaveLength(1);
    expect(checkLegibility(obs, qa, matrixPlan)).toHaveLength(0);
  });

  it("relaxes the floor for a PACKED board's items, but not a merely dense one (D30)", () => {
    const obs = baseObservation({ textSamples: [itemSample(13, "p1")] });
    const listPlan: PlanScreen = {
      id: "s1",
      sections: [{ title: "T", representation: "list", items: ["p1"] }],
    };
    // 13px fails the 14px item floor; a packed board (compact price wall) gets the 12px floor.
    expect(checkLegibility(obs, qa, listPlan)).toHaveLength(1);
    expect(checkLegibility(obs, qa, listPlan, { overBudget: true, tier: "packed" })).toHaveLength(
      0,
    );
    // A merely dense board keeps the full floor — only the maximally-dense tier is relaxed.
    expect(checkLegibility(obs, qa, listPlan, { overBudget: true, tier: "dense" })).toHaveLength(1);
  });

  it("passes item text at or above the floor", () => {
    const obs = baseObservation({ textSamples: [itemSample(18)] });
    expect(checkLegibility(obs, qa)).toHaveLength(0);
  });
});

describe("runRenderedChecks", () => {
  it("returns nothing for a clean render", () => {
    expect(runRenderedChecks(baseObservation(), qa)).toHaveLength(0);
  });
});
