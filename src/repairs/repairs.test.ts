import { describe, expect, it } from "vitest";

import type { QaFinding, ResolvedTheme } from "../domain/types";
import type { Rgba } from "../ports/browser";
import { contrastRatio } from "../qa/contrast";
import { parseColor } from "../qa/colors";
import { makeFinding } from "../qa/finding";
import {
  applyDeterministicRepairs,
  chooseAccessibleColor,
  contrastIsFixable,
  hasDeterministicRepair,
} from "./index";

const theme: ResolvedTheme = {
  id: "t",
  name: "T",
  tokens: {
    colors: { bg: "#1f2a24", text: "#f3efe6", accent: "#8a9a5b", price: "#f0d9a7" },
    fontFamilies: {},
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

  it("covers descendants when the region is a container (child has its own colour utility)", () => {
    // Failing text is a CHILD of the region (a card label), so the override must reach descendants.
    const cardFinding = makeFinding({
      kind: "contrast",
      source: "deterministic",
      severity: "critical",
      tag: "mechanical",
      hardGate: true,
      deterministicallyFixable: true,
      region: '[data-item-id="card1"]',
      message: "low contrast",
      data: { bg: { r: 53, g: 70, b: 59, a: 1 }, fg: { r: 138, g: 154, b: 91, a: 1 } },
    });
    const result = applyDeterministicRepairs("<head></head><body></body>", [cardFinding], theme);
    expect(result.applied).toBe(true);
    // The descendant arm (`<sel> *`) is what reaches the failing child element.
    expect(result.html).toContain('[data-item-id="card1"] *{color:var(--color-');
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

  it("rejects a contrast finding on a bare-tag selector (would recolour the whole page)", () => {
    const generic = makeFinding({
      kind: "contrast",
      source: "deterministic",
      severity: "critical",
      tag: "mechanical",
      hardGate: true,
      deterministicallyFixable: true,
      region: "span",
      message: "low contrast on a bare span",
      data: { bg: yellow, fg: { r: 255, g: 255, b: 255, a: 1 }, required: 4.5 },
    });
    expect(hasDeterministicRepair([generic])).toBe(false);
  });
});

describe("contrastIsFixable (guards the repair from destructive / futile swaps)", () => {
  const overImage = makeFinding({
    kind: "contrast",
    source: "deterministic",
    severity: "critical",
    tag: "mechanical",
    hardGate: true,
    deterministicallyFixable: true,
    region: '[data-item-id="x"] [data-bind="price"]',
    message: "text over a mid-tone photo",
    // A mid-grey background: no theme token clears 4.5:1, so a colour swap can't fix it.
    data: {
      bg: { r: 128, g: 128, b: 128, a: 1 },
      fg: { r: 255, g: 255, b: 255, a: 1 },
      required: 4.5,
    },
  });
  const genericSelector = makeFinding({
    kind: "contrast",
    source: "deterministic",
    severity: "critical",
    tag: "mechanical",
    hardGate: true,
    deterministicallyFixable: true,
    region: "span",
    message: "bare span",
    data: { bg: yellow, fg: { r: 255, g: 255, b: 255, a: 1 }, required: 4.5 },
  });

  it("is true for a scopable selector over a solid bg a token can clear", () => {
    expect(contrastIsFixable(contrastFinding, theme)).toBe(true);
  });

  it("is false for a bare-tag selector (unscopable → would recolour everything)", () => {
    expect(contrastIsFixable(genericSelector, theme)).toBe(false);
    // ...and the repair therefore leaves the markup untouched (routes to re-paint instead).
    const result = applyDeterministicRepairs(
      "<head></head><body><span>x</span></body>",
      [genericSelector],
      theme,
    );
    expect(result.applied).toBe(false);
  });

  it("is false over a mid-tone photo where no token reaches the required ratio", () => {
    expect(contrastIsFixable(overImage, theme)).toBe(false);
    const result = applyDeterministicRepairs("<head></head><body></body>", [overImage], theme);
    expect(result.applied).toBe(false);
  });
});
