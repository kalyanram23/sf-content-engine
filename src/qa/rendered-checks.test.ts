import { describe, expect, it } from "vitest";

import { defaultQaConfig } from "../config/qa";
import type { PlanScreen } from "../domain/types";
import type { RenderObservation } from "../ports/browser";
import {
  checkContrast,
  checkDeadBand,
  checkDensity,
  checkImageGeometry,
  checkImages,
  checkItemCutoff,
  checkLegibility,
  checkOverflow,
  checkViewport,
  runRenderedChecks,
} from "./rendered-checks";
import type { ImageObservation } from "../ports/browser";
import { cleanObservation, deadSpaceObservation } from "../testing/fakes/browser";

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
    // ~8% too tall → uniform fit ~0.926, above the 0.9 minShrinkFactor floor (small trims only);
    // no item-bound text, so no legibility floor binds.
    const obs = baseObservation({
      scroll: { scrollWidth: 1920, scrollHeight: 1166, clientWidth: 1920, clientHeight: 1080 },
    });
    const [finding] = checkOverflow(obs, qa);
    expect(finding?.deterministicallyFixable).toBe(true);
    expect(finding?.data?.["shrinkFactor"]).toBeCloseTo(0.926, 3);
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
    // 3× too tall → fit ~0.33 < minShrinkFactor 0.9: too aggressive to paper over → re-paint.
    const obs = baseObservation({
      scroll: { scrollWidth: 1920, scrollHeight: 3240, clientWidth: 1920, clientHeight: 1080 },
    });
    const [finding] = checkOverflow(obs, qa);
    expect(finding?.deterministicallyFixable).toBe(false);
  });
});

describe("checkItemCutoff (silent clipping — the QA blindspot)", () => {
  const inViewportRect = { id: "ok", top: 100, bottom: 900, left: 100, right: 1600 };

  it("passes when every item rect sits fully inside the viewport", () => {
    const obs = baseObservation({
      itemRects: [inViewportRect, { id: "ok2", top: 0, bottom: 1080, left: 0, right: 1920 }],
    });
    expect(checkItemCutoff(obs, qa)).toHaveLength(0);
  });

  it("flags an item whose bottom is clipped past the viewport, naming it (major, not fixable)", () => {
    // scroll is CLEAN (checkOverflow stays silent), but item "e-last" is sliced 90px past the edge.
    const obs = baseObservation({
      scroll: { scrollWidth: 1920, scrollHeight: 1080, clientWidth: 1920, clientHeight: 1080 },
      itemRects: [inViewportRect, { id: "e-last", top: 1020, bottom: 1170, left: 100, right: 900 }],
    });
    // The scroll-based overflow check is blind to this — proving the blindspot.
    expect(checkOverflow(obs, qa)).toHaveLength(0);
    const findings = checkItemCutoff(obs, qa);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "item-cutoff",
      source: "deterministic",
      severity: "major",
      tag: "content",
      deterministicallyFixable: false,
    });
    expect(findings[0]?.message).toContain("e-last");
    expect(findings[0]?.data?.["items"]).toEqual(["e-last"]);
    expect(findings[0]?.data?.["count"]).toBe(1);
    expect(findings[0]?.data?.["worstOverhangPx"]).toBe(90);
  });

  it("flags an item clipped past the RIGHT edge too", () => {
    const obs = baseObservation({
      itemRects: [{ id: "wide", top: 100, bottom: 400, left: 1000, right: 1980 }],
    });
    const findings = checkItemCutoff(obs, qa);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.data?.["worstOverhangPx"]).toBe(60);
  });

  it("aggregates multiple clipped items into ONE finding, reporting the worst overhang", () => {
    const obs = baseObservation({
      itemRects: [
        { id: "a", top: 1000, bottom: 1120, left: 0, right: 500 }, // 40px over
        { id: "b", top: 1000, bottom: 1200, left: 0, right: 500 }, // 120px over (worst)
        inViewportRect,
      ],
    });
    const findings = checkItemCutoff(obs, qa);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.data?.["items"]).toEqual(["a", "b"]);
    expect(findings[0]?.data?.["count"]).toBe(2);
    expect(findings[0]?.data?.["worstOverhangPx"]).toBe(120);
  });

  it("tolerates a sub-pixel overrun within the configured tolerance", () => {
    // 1px past the edge is within the 2px default tolerance → no finding.
    const obs = baseObservation({
      itemRects: [{ id: "edge", top: 0, bottom: 1081, left: 0, right: 1920 }],
    });
    expect(checkItemCutoff(obs, qa)).toHaveLength(0);
  });

  it("emits nothing when itemRects is absent (older observations — backward compatible)", () => {
    expect(checkItemCutoff(baseObservation(), qa)).toHaveLength(0);
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

describe("checkDeadBand", () => {
  it("flags a large contiguous interior empty band and names its pixel region", () => {
    // 26 rows: content top and bottom, a 10-row zero band in the middle (~38% of the canvas).
    const rowFill = [
      ...Array<number>(10).fill(5),
      ...Array<number>(10).fill(0),
      ...Array<number>(6).fill(5),
    ];
    const findings = checkDeadBand(baseObservation({ rowFill }), qa);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      kind: "dead-band",
      source: "deterministic",
      severity: "major",
      tag: "layout",
      deterministicallyFixable: false,
    });
    // Pixel coords come from the grid geometry over the 1080px viewport (10/26 → ~415..831px).
    expect(findings[0]?.data?.["fromY"]).toBe(415);
    expect(findings[0]?.data?.["toY"]).toBe(831);
    expect(findings[0]?.data?.["bandRatio"]).toBeCloseTo(10 / 26, 5);
    expect(findings[0]?.message).toMatch(/Empty band from ~415px to ~831px/);
  });

  it("ignores empty rows that sit ONLY in the first/last grid row (top/bottom margins)", () => {
    const rowFill = [0, ...Array<number>(24).fill(5), 0];
    expect(checkDeadBand(baseObservation({ rowFill }), qa)).toHaveLength(0);
  });

  it("respects the threshold — a band just under maxBandRatio passes, just over fails", () => {
    const under = [
      ...Array<number>(11).fill(5),
      ...Array<number>(4).fill(0),
      ...Array<number>(11).fill(5),
    ];
    expect(checkDeadBand(baseObservation({ rowFill: under }), qa)).toHaveLength(0); // 4/26 ≈ 0.154
    const over = [
      ...Array<number>(11).fill(5),
      ...Array<number>(5).fill(0),
      ...Array<number>(10).fill(5),
    ];
    expect(checkDeadBand(baseObservation({ rowFill: over }), qa)).toHaveLength(1); // 5/26 ≈ 0.192
  });

  it("emits nothing when rowFill is absent (old observations) or the grid is fully filled", () => {
    expect(checkDeadBand(baseObservation(), qa)).toHaveLength(0);
    expect(checkDeadBand(baseObservation({ rowFill: Array<number>(26).fill(5) }), qa)).toHaveLength(
      0,
    );
  });

  it("keys on CONTENT fill: a full-height tinted panel with content only up top still FIRES", () => {
    // The lower half is covered by a full-height tinted panel, so EVERY row is surface-"filled"
    // (rowFill) — the panel-only check stayed silent (the bug). But real content (text/images)
    // reaches only the top ~half, so rowContentFill has a long zero run below → dead space is caught.
    const rowFill = Array<number>(26).fill(10); // a tinted panel covering the whole canvas
    const rowContentFill = [...Array<number>(12).fill(6), ...Array<number>(14).fill(0)];
    const findings = checkDeadBand(baseObservation({ rowFill, rowContentFill }), qa);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("dead-band");
  });

  it("falls back to rowFill when rowContentFill is absent (older observations)", () => {
    const rowFill = [
      ...Array<number>(11).fill(5),
      ...Array<number>(6).fill(0),
      ...Array<number>(9).fill(5),
    ];
    // rowContentFill undefined → keys on rowFill; the 6-row zero band (~23%) fires.
    expect(checkDeadBand(baseObservation({ rowFill }), qa)).toHaveLength(1);
  });

  it("treats svg-only rows as content (deliberate visual matter), not dead space", () => {
    // In the browser an IMG/SVG sample increments rowContentFill, so a decorative-svg band is NOT
    // empty of content — checkDeadBand only flags ZERO-content runs. A mid-band of svg-only rows
    // (content count 2) therefore does not fire.
    const rowContentFill = [
      ...Array<number>(9).fill(5),
      ...Array<number>(8).fill(2),
      ...Array<number>(9).fill(5),
    ];
    expect(checkDeadBand(baseObservation({ rowContentFill }), qa)).toHaveLength(0);
  });

  it("fires on the deadSpaceObservation fake but stays silent on the clean fake (coherent rowFill)", () => {
    expect(checkDeadBand(cleanObservation(), qa)).toHaveLength(0);
    const findings = checkDeadBand(deadSpaceObservation(), qa);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("dead-band");
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

  it("skips a HIDDEN over-cropped slide but still fires on the visible one (Fix 2 — carousel noise)", () => {
    // A gallery-fade carousel: the front slide is visible, the rest opacity-0. Both are cover slides
    // in an extreme 4:3-in->3.9:1 band (over-cropped), but only the visible one may be graded.
    const overCropped = {
      naturalWidth: 1200,
      naturalHeight: 900,
      renderedWidth: 1400,
      renderedHeight: 360,
    };
    const hidden = checkImageGeometry(
      baseObservation({ images: [img({ ...overCropped, visible: false })] }),
      qa,
    );
    expect(hidden).toHaveLength(0);
    const visible = checkImageGeometry(
      baseObservation({ images: [img({ ...overCropped, visible: true })] }),
      qa,
    );
    expect(visible).toHaveLength(1);
    expect(visible[0]?.kind).toBe("image-crop");
  });

  it("grades an over-cropped image when the visible field is absent (old observations behave as before)", () => {
    const findings = checkImageGeometry(
      baseObservation({
        images: [
          img({ naturalWidth: 1200, naturalHeight: 900, renderedWidth: 1400, renderedHeight: 360 }),
        ],
      }),
      qa,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.kind).toBe("image-crop");
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
