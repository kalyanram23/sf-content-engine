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

  it("scopes the override to an element-precise card ref, not the whole card", () => {
    // Card text without a data-bind is now sampled with an ELEMENT-PRECISE ref (`[card] h3`), so the
    // override lands on that element (and its own subtree) alone — a whole-card `*` recolour would
    // flip a sibling face on the opposite background (the oscillation this replaced).
    const nameFinding = makeFinding({
      kind: "contrast",
      source: "deterministic",
      severity: "critical",
      tag: "mechanical",
      hardGate: true,
      deterministicallyFixable: true,
      region: '[data-item-id="card1"] h3',
      message: "low contrast on the item name",
      data: { bg: { r: 53, g: 70, b: 59, a: 1 }, fg: { r: 138, g: 154, b: 91, a: 1 } },
    });
    const result = applyDeterministicRepairs("<head></head><body></body>", [nameFinding], theme);
    expect(result.applied).toBe(true);
    expect(result.html).toContain(
      '[data-item-id="card1"] h3,[data-item-id="card1"] h3 *{color:var(--color-',
    );
    // NOT the bare card container (which would recolour every face of the card).
    expect(result.html).not.toContain('[data-item-id="card1"],[data-item-id="card1"] *');
  });

  it("merges into ONE contrast block on repeated repair (no stacked/duplicate blocks)", () => {
    const html = `<head></head><body><article data-item-id="id4"><span data-bind="price" style="color:#fff">$8.99</span></article></body>`;
    const once = applyDeterministicRepairs(html, [contrastFinding], theme);
    const twice = applyDeterministicRepairs(once.html, [contrastFinding], theme);
    // A second pass runs on the already-repaired HTML: it MERGES into the existing block instead of
    // appending a second one, and the selector is already covered → the markup is left unchanged.
    expect((twice.html.match(/data-repair="contrast"/g) ?? []).length).toBe(1);
    expect(twice.html).toBe(once.html);
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

  it("is TRUE for a path-scoped ref outside a card (the invisible-text fix), and scopes to it", () => {
    // Text OUTSIDE an item card used to sample as a bare tag ("span") — un-repairable, so a 1.00:1
    // invisible-text finding survived the loop. The sampler now emits a structural PATH ref, which
    // scopes; the repair must recolour exactly that path (and its subtree), never every span.
    const pathFinding = makeFinding({
      kind: "contrast",
      source: "deterministic",
      severity: "critical",
      tag: "mechanical",
      hardGate: true,
      deterministicallyFixable: true,
      region: "header > span:nth-of-type(2)",
      message: "invisible header text (fg == bg)",
      data: { bg: yellow, fg: { r: 255, g: 255, b: 0, a: 1 }, required: 4.5 },
    });
    expect(contrastIsFixable(pathFinding, theme)).toBe(true);
    const result = applyDeterministicRepairs("<head></head><body></body>", [pathFinding], theme);
    expect(result.applied).toBe(true);
    // Scoped to the path (and its subtree via ` *`), referencing a token var — the child combinator
    // is preserved so the override lands on that element alone, not every span on the board.
    expect(result.html).toContain(
      "header > span:nth-of-type(2),header > span:nth-of-type(2) *{color:var(--color-",
    );
  });

  it("is false for a bare item-card container (mixed background → single-token recolour is destructive)", () => {
    // A bare `[data-item-id="X"]` ref is a whole card: a light pill sits over the dark card body, so
    // one token fixes a face and breaks its sibling, then the next repair flips it — oscillation.
    // A theme token CLEARS this solid card bg (so only the bare-container guard makes it unfixable).
    const bareCard = makeFinding({
      kind: "contrast",
      source: "deterministic",
      severity: "critical",
      tag: "mechanical",
      hardGate: true,
      deterministicallyFixable: true,
      region: '[data-item-id="marg"]',
      message: "mixed-background card container",
      data: {
        bg: { r: 44, g: 35, b: 88, a: 1 },
        fg: { r: 141, g: 230, b: 173, a: 1 },
        required: 4.5,
      },
    });
    expect(contrastIsFixable(bareCard, theme)).toBe(false);
    const result = applyDeterministicRepairs("<head></head><body></body>", [bareCard], theme);
    expect(result.applied).toBe(false);
    expect(result.html).not.toContain('data-repair="contrast"');
  });
});

describe("applyDeterministicRepairs — overflow shrink-to-fit (D31)", () => {
  const overflowFinding: QaFinding = makeFinding({
    kind: "overflow",
    source: "deterministic",
    severity: "major",
    tag: "layout",
    deterministicallyFixable: true,
    message: "overflows",
    data: { overshootX: 0, overshootY: 162, shrinkFactor: 0.869, overflowing: ["section.x"] },
  });

  it("injects a scoped shrink-to-fit style scaling the content root by the finding's factor", () => {
    const result = applyDeterministicRepairs("<main>menu</main>", [overflowFinding], theme);
    expect(result.applied).toBe(true);
    expect(result.html).toContain('data-repair="fit"');
    expect(result.html).toContain("transform:scale(0.869)");
    // Centred origin splits the residual side band into symmetric margins (not a dead right flank).
    expect(result.html).toContain("transform-origin:top center");
    // The html,body clamp makes documentElement.scrollHeight read the TRANSFORMED box, so the
    // overflow finding measurably clears. A bare transform changes paint, not layout — the
    // untransformed root height still set scrollHeight and the finding re-fired with identical
    // numbers, so the repaired candidate never beat `best` and shipped unrepaired.
    expect(result.html).toContain("html,body{height:100%;overflow:hidden;}");
  });

  it("emits token-lint-clean CSS (no raw hex, no raw px — unitless scale + keyword origin)", () => {
    const result = applyDeterministicRepairs("<main>menu</main>", [overflowFinding], theme);
    const styleText = result.html.match(/<style data-repair="fit"[^>]*>([\s\S]*?)<\/style>/)![1]!;
    expect(styleText).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(styleText).not.toMatch(/\d+px\b/);
  });

  it("does NOT shrink an overflow the check marked un-fixable (routes to re-paint instead)", () => {
    const notFixable = makeFinding({
      kind: "overflow",
      source: "deterministic",
      severity: "major",
      tag: "layout",
      // deterministicallyFixable defaults false; no shrinkFactor → the repair declines.
      message: "overflows too much to shrink legibly",
      data: { overshootY: 900 },
    });
    const result = applyDeterministicRepairs("<main>menu</main>", [notFixable], theme);
    expect(result.applied).toBe(false);
    expect(result.html).not.toContain('data-repair="fit"');
  });

  it("does NOT shrink below the 0.9 bound (the check leaves such an overflow un-fixable → re-paint)", () => {
    // A ~0.7 fit factor would letterbox the whole board (30% smaller type + wide empty side bands) —
    // worse than a fresh re-paint. Under the raised `minShrinkFactor` floor (0.9) the check leaves
    // the finding NOT deterministicallyFixable (default false, no fixable flag), so the repair
    // declines and routing escalates to re-paint rather than shipping a shrunk-to-a-crawl board.
    const belowBound = makeFinding({
      kind: "overflow",
      source: "deterministic",
      severity: "major",
      tag: "layout",
      message: "overflows; fit factor 0.7 below the shrink bound",
      data: { overshootY: 320, shrinkFactor: 0.7 },
    });
    const result = applyDeterministicRepairs("<main>menu</main>", [belowBound], theme);
    expect(result.applied).toBe(false);
    expect(result.html).not.toContain('data-repair="fit"');
  });

  it("is idempotent + bounded: applying twice yields ONE fit block at the same factor", () => {
    const once = applyDeterministicRepairs("<main>menu</main>", [overflowFinding], theme);
    const twice = applyDeterministicRepairs(once.html, [overflowFinding], theme);
    // Exactly one fit block — the second apply REPLACES rather than stacking a second transform.
    expect((twice.html.match(/data-repair="fit"/g) ?? []).length).toBe(1);
    expect(twice.html).toContain("transform:scale(0.869)");
    // NOT compounded to 0.869×0.869 ≈ 0.755 — applying twice does not double-shrink.
    expect(twice.html).not.toContain("scale(0.755");
  });

  it("HONESTLY reports no-change on a re-repair of already-shrunk markup (D65 — the silent no-op)", () => {
    // The repair-loop dead-end's root cause: re-applying the overflow fix on already-shrunk markup
    // replaces the fit block with a byte-identical one and used to report `applied:true` — printing
    // "deterministic repair applied" while the output never changed, so the loop repaired forever.
    // The second pass must now report `applied:false` (no progress) so the loop can escalate.
    const once = applyDeterministicRepairs("<main>menu</main>", [overflowFinding], theme);
    expect(once.applied).toBe(true);
    const twice = applyDeterministicRepairs(once.html, [overflowFinding], theme);
    expect(twice.html).toBe(once.html); // byte-identical…
    expect(twice.applied).toBe(false); // …so it must NOT claim it was applied.
  });

  it("fixes a contrast AND an overflow finding in one repair pass", () => {
    const html = `<head></head><body><article data-item-id="id4"><span data-bind="price" style="color:#fff">$8.99</span></article></body>`;
    const result = applyDeterministicRepairs(html, [contrastFinding, overflowFinding], theme);
    expect(result.applied).toBe(true);
    expect(result.html).toContain('data-repair="contrast"');
    expect(result.html).toContain('data-repair="fit"');
  });
});

describe("hasDeterministicRepair — overflow (D31)", () => {
  it("detects a fixable overflow finding", () => {
    const fixable = makeFinding({
      kind: "overflow",
      source: "deterministic",
      severity: "major",
      tag: "layout",
      deterministicallyFixable: true,
      message: "overflows",
      data: { shrinkFactor: 0.9 },
    });
    expect(hasDeterministicRepair([fixable])).toBe(true);
  });

  it("ignores an overflow the check declined to mark fixable", () => {
    const notFixable = makeFinding({
      kind: "overflow",
      source: "deterministic",
      severity: "major",
      tag: "layout",
      message: "overflows",
      data: { overshootY: 900 },
    });
    expect(hasDeterministicRepair([notFixable])).toBe(false);
  });
});
