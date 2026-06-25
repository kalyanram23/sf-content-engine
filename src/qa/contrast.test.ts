import { describe, expect, it } from "vitest";

import { defaultQaConfig } from "../config/qa";
import { parseColor } from "./colors";
import { compositeOver, contrastRatio, isLargeText, requiredRatio } from "./contrast";

const contrastCfg = defaultQaConfig().contrast;

function color(s: string) {
  const c = parseColor(s);
  if (!c) throw new Error(`bad color ${s}`);
  return c;
}

describe("parseColor", () => {
  it("parses hex shorthand, full, and alpha", () => {
    expect(parseColor("#fff")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
    expect(parseColor("#000000")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
    expect(parseColor("#ff000080")).toEqual({ r: 255, g: 0, b: 0, a: 128 / 255 });
  });

  it("parses rgb()/rgba() and named colours", () => {
    expect(parseColor("rgb(10, 20, 30)")).toEqual({ r: 10, g: 20, b: 30, a: 1 });
    expect(parseColor("rgba(10,20,30,0.5)")).toEqual({ r: 10, g: 20, b: 30, a: 0.5 });
    expect(parseColor("white")).toEqual({ r: 255, g: 255, b: 255, a: 1 });
  });

  it("returns null for nonsense", () => {
    expect(parseColor("not-a-color")).toBeNull();
    expect(parseColor("#12")).toBeNull();
  });
});

describe("contrastRatio", () => {
  it("is 21 for black/white and symmetric", () => {
    expect(contrastRatio(color("#000"), color("#fff"))).toBeCloseTo(21, 5);
    expect(contrastRatio(color("#fff"), color("#000"))).toBeCloseTo(21, 5);
  });

  it("is 1 for identical colours", () => {
    expect(contrastRatio(color("#777"), color("#777"))).toBeCloseTo(1, 5);
  });

  it("flags the spec's failing example: white text on a yellow background (<4.5)", () => {
    // Acceptance test #2 seed (spec §7).
    expect(contrastRatio(color("#ffffff"), color("#ffff00"))).toBeLessThan(4.5);
  });

  it("composites a translucent foreground over the background before measuring", () => {
    // Fully transparent fg → ratio collapses toward 1 (fg becomes the bg).
    const ratio = contrastRatio({ r: 0, g: 0, b: 0, a: 0 }, color("#fff"));
    expect(ratio).toBeCloseTo(1, 5);
  });
});

describe("compositeOver", () => {
  it("blends by alpha", () => {
    expect(compositeOver({ r: 0, g: 0, b: 0, a: 0.5 }, { r: 255, g: 255, b: 255, a: 1 })).toEqual({
      r: 127.5,
      g: 127.5,
      b: 127.5,
    });
  });
});

describe("requiredRatio / isLargeText", () => {
  it("uses the relaxed large-text threshold for big or bold-big text", () => {
    expect(isLargeText(48, false, contrastCfg)).toBe(true);
    expect(isLargeText(20, true, contrastCfg)).toBe(true); // >= 18.66 bold
    expect(isLargeText(16, false, contrastCfg)).toBe(false);
    expect(requiredRatio(48, false, contrastCfg)).toBe(3);
    expect(requiredRatio(16, false, contrastCfg)).toBe(4.5);
  });
});
