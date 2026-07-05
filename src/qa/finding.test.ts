import { describe, expect, it } from "vitest";

import { FindingKind, makeFinding, serializeFindingsForPrompt } from "./finding";

/**
 * `serializeFindingsForPrompt` turns QA findings into compact, element-anchored prompt lines so the
 * painter/repairer receive the machine-precise anchors the checks compute (overshoot px, contrast
 * ratio, overflowing refs) instead of a stripped kind/message. It must expose ONLY a per-kind
 * whitelist of `data` keys, cap the overflowing ref list, survive vision findings with unknown
 * kinds/absent data, and hard-cap each line.
 */
describe("serializeFindingsForPrompt", () => {
  it("surfaces the overflow whitelist (overshoot + refs) and drops un-listed data keys", () => {
    const line = serializeFindingsForPrompt([
      makeFinding({
        kind: FindingKind.Overflow,
        source: "deterministic",
        severity: "major",
        tag: "layout",
        message: "Content overflows the screen (overshoot 0x26px).",
        data: {
          overshootX: 0,
          overshootY: 26,
          overflowing: ['[data-item-id="a"]', '[data-item-id="b"]'],
          bbox: [0, 0, 100, 100],
        },
      }),
    ]);
    expect(line).toContain("[major] overflow @ screen:");
    expect(line).toContain("overshootX=0");
    expect(line).toContain("overshootY=26");
    expect(line).toContain('overflowing=[data-item-id="a"], [data-item-id="b"]');
    // Un-whitelisted keys (raw bbox array) never leak.
    expect(line).not.toContain("bbox");
  });

  it("caps the overflowing ref list at 5 and notes the remainder", () => {
    const line = serializeFindingsForPrompt([
      makeFinding({
        kind: FindingKind.Overflow,
        source: "deterministic",
        severity: "major",
        tag: "layout",
        message: "overflow",
        data: {
          overshootX: 5,
          overshootY: 40,
          overflowing: ["s1", "s2", "s3", "s4", "s5", "s6", "s7", "s8"],
        },
      }),
    ]);
    expect(line).toContain("overflowing=s1, s2, s3, s4, s5 +3 more");
    expect(line).not.toContain("s6");
  });

  it("surfaces only ratio/required/fontPx for contrast (never fg/bg), with region + itemId", () => {
    const line = serializeFindingsForPrompt([
      makeFinding({
        kind: FindingKind.Contrast,
        source: "deterministic",
        severity: "critical",
        tag: "mechanical",
        region: '[data-item-id="a"] [data-bind="price"]',
        itemId: "a",
        message: "Contrast 1.38:1 below required 4.5:1.",
        data: {
          ratio: 1.379,
          required: 4.5,
          fg: "#111111",
          bg: "#222222",
          fontPx: 18,
          bold: false,
        },
      }),
    ]);
    expect(line).toContain(
      '[critical] contrast @ [data-item-id="a"] [data-bind="price"] (item a):',
    );
    expect(line).toContain("ratio=1.38");
    expect(line).toContain("required=4.50");
    expect(line).toContain("fontPx=18");
    expect(line).not.toContain("fg=");
    expect(line).not.toContain("#111111");
  });

  it("surfaces fillRatio + whichever bound is present for density (minFill vs maxFill)", () => {
    const under = serializeFindingsForPrompt([
      makeFinding({
        kind: FindingKind.Density,
        source: "deterministic",
        severity: "major",
        tag: "layout",
        message: "under-filled",
        data: { fillRatio: 0.42, minFill: 0.55, kind: "under" },
      }),
    ]);
    expect(under).toContain("fillRatio=0.42");
    expect(under).toContain("minFill=0.55");
    expect(under).not.toContain("maxFill");

    const over = serializeFindingsForPrompt([
      makeFinding({
        kind: FindingKind.Density,
        source: "deterministic",
        severity: "major",
        tag: "layout",
        message: "over-crammed",
        data: { fillRatio: 0.92, maxFill: 0.85, kind: "over" },
      }),
    ]);
    expect(over).toContain("fillRatio=0.92");
    expect(over).toContain("maxFill=0.85");
    expect(over).not.toContain("minFill");
  });

  it("surfaces ref + aspects for image findings, dropping objectFit/deviation", () => {
    const line = serializeFindingsForPrompt([
      makeFinding({
        kind: FindingKind.ImageDistortion,
        source: "deterministic",
        severity: "major",
        tag: "layout",
        region: "hero-1",
        message: "distorted",
        data: {
          ref: "hero-1",
          objectFit: "fill",
          renderedAspect: 1.777,
          naturalAspect: 1.333,
          deviation: 0.34,
        },
      }),
    ]);
    expect(line).toContain("ref=hero-1");
    expect(line).toContain("renderedAspect=1.78");
    expect(line).toContain("naturalAspect=1.33");
    expect(line).not.toContain("objectFit");
    expect(line).not.toContain("deviation");
  });

  it("falls back to message-only for an unknown (vision) kind — no specifics tail", () => {
    const line = serializeFindingsForPrompt([
      makeFinding({
        kind: "muddy-hero",
        source: "vision",
        severity: "minor",
        tag: "layout",
        region: "top-left",
        message: "Hero photo reads muddy behind the title.",
        data: { note: "arbitrary", bbox: [1, 2, 3, 4] },
      }),
    ]);
    expect(line).toBe("- [minor] muddy-hero @ top-left: Hero photo reads muddy behind the title.");
    expect(line).not.toContain(" | ");
  });

  it("never crashes on a vision finding with no data or no region", () => {
    const line = serializeFindingsForPrompt([
      makeFinding({
        kind: "dead-space",
        source: "vision",
        severity: "major",
        tag: "layout",
        message: "Large empty band at the bottom.",
      }),
    ]);
    expect(line).toBe("- [major] dead-space @ screen: Large empty band at the bottom.");
  });

  it("hard-caps each line and marks the truncation", () => {
    const line = serializeFindingsForPrompt([
      makeFinding({
        kind: "dead-space",
        source: "vision",
        severity: "major",
        tag: "layout",
        message: "x".repeat(600),
      }),
    ]);
    expect(line.length).toBeLessThanOrEqual(480);
    expect(line.endsWith("…")).toBe(true);
  });

  it("emits one line per finding, newline-joined", () => {
    const out = serializeFindingsForPrompt([
      makeFinding({
        kind: FindingKind.Overflow,
        source: "deterministic",
        severity: "major",
        tag: "layout",
        message: "overflow",
        data: { overshootX: 0, overshootY: 12 },
      }),
      makeFinding({
        kind: "dead-space",
        source: "vision",
        severity: "minor",
        tag: "layout",
        message: "empty band",
      }),
    ]);
    expect(out.split("\n")).toHaveLength(2);
  });
});
