import { describe, expect, it } from "vitest";

import { defaultQaConfig } from "../config/qa";
import type { RenderObservation } from "../ports/browser";
import {
  checkContrast,
  checkDensity,
  checkImages,
  checkLegibility,
  checkOverflow,
  checkViewport,
  runRenderedChecks,
} from "./rendered-checks";

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
    images: [{ ref: "hero", loaded: true, naturalWidth: 1200 }],
    ...overrides,
  };
}

describe("checkViewport", () => {
  it("passes when the rendered viewport matches the target", () => {
    expect(checkViewport(baseObservation(), qa)).toBeNull();
  });

  it("flags a DPR/size mismatch as a hard precondition failure", () => {
    const finding = checkViewport(
      baseObservation({ actualViewport: { width: 1920, height: 1080, dpr: 2 } }),
      qa,
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
});

describe("checkImages", () => {
  it("flags an unloaded gallery image", () => {
    const findings = checkImages(
      baseObservation({ images: [{ ref: "g1", loaded: false, naturalWidth: 0 }] }),
    );
    expect(findings[0]).toMatchObject({ kind: "image-slot", region: "g1" });
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
