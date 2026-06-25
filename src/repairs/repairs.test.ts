import { describe, expect, it } from "vitest";

import type { QaFinding, ResolvedTheme } from "../domain/types";
import type { Rgba } from "../ports/browser";
import { contrastRatio } from "../qa/contrast";
import { parseColor } from "../qa/colors";
import { makeFinding } from "../qa/finding";
import { applyDeterministicRepairs, chooseAccessibleColor, hasDeterministicRepair } from "./index";

const theme: ResolvedTheme = {
  id: "t",
  name: "T",
  tokens: {
    colors: { bg: "#1f2a24", text: "#f3efe6", accent: "#8a9a5b", price: "#f0d9a7" },
    fontFamilies: {},
    fontSizes: {},
    spacing: {},
    radius: {},
  },
  motion: [{ name: "fade-in", kind: "css" }],
  assets: { backgrounds: [], fonts: [] },
  density: "balanced",
};

const yellow: Rgba = { r: 255, g: 255, b: 0, a: 1 };

const contrastFinding: QaFinding = makeFinding({
  kind: "contrast",
  source: "deterministic",
  severity: "critical",
  tag: "mechanical",
  hardGate: true,
  deterministicallyFixable: true,
  region: '[data-item-id="id4"] [data-bind="price"]',
  message: "white on yellow",
  data: {
    fg: { r: 255, g: 255, b: 255, a: 1 },
    bg: yellow,
    fontPx: 16,
    bold: false,
    ratio: 1.07,
    required: 4.5,
  },
});

describe("chooseAccessibleColor", () => {
  it("picks a TOKEN NAME whose colour clears the required contrast over the background", () => {
    const tokenName = chooseAccessibleColor(yellow, theme);
    const value = theme.tokens.colors[tokenName];
    expect(value).toBeDefined();
    const rgba = parseColor(value!);
    expect(rgba).not.toBeNull();
    expect(contrastRatio(rgba!, yellow)).toBeGreaterThanOrEqual(4.5);
  });
});

describe("applyDeterministicRepairs", () => {
  it("injects a scoped contrast override referencing a token var (no raw hex)", () => {
    const html = `<head></head><body><article data-item-id="id4"><span data-bind="price" style="color:#fff">$8.99</span></article></body>`;
    const result = applyDeterministicRepairs(html, [contrastFinding], theme);
    expect(result.applied).toBe(true);
    expect(result.html).toContain('data-repair="contrast"');
    expect(result.html).toContain('[data-item-id="id4"] [data-bind="price"]');
    expect(result.html).toContain("var(--color-");
    expect(result.html).toContain("!important");
    // No raw hex injected into the markup (stays on the rails / passes token-lint).
    expect(result.html).not.toMatch(/\{color:#[0-9a-f]/i);
  });

  it("is a no-op when no finding is deterministically repairable", () => {
    const density = makeFinding({
      kind: "density",
      source: "deterministic",
      severity: "major",
      tag: "layout",
      message: "x",
    });
    const html = "<body>x</body>";
    const result = applyDeterministicRepairs(html, [density], theme);
    expect(result.applied).toBe(false);
    expect(result.html).toBe(html);
  });
});

describe("hasDeterministicRepair", () => {
  it("detects a repairable contrast finding", () => {
    expect(hasDeterministicRepair([contrastFinding])).toBe(true);
    expect(hasDeterministicRepair([])).toBe(false);
  });
});
