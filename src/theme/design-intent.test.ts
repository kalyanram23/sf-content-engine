import { describe, expect, it } from "vitest";

import { parseOrThrow } from "../domain/parse";
import { resolvedThemeSchema } from "../domain/schemas";
import type { ResolvedTheme } from "../domain/types";
import { describeDesignIntent } from "./design-intent";

/**
 * `describeDesignIntent` distills a resolved theme into the DESIGN INTENT brief handed to the vision
 * critic (via `buildCritiqueRequest` → both the per-iteration visionQA pass AND the freeze make-good
 * critique). "theme-adherence" and "intentional-design" can only be graded honestly if the brief
 * carries what the theme actually asked for — the DOs it should honour and the DON'Ts it must avoid.
 * These tests pin: the DO list is present (and framed to grade positively), the DON'T list is
 * present, DOs come before DON'Ts, and NEITHER list is silently truncated when the theme's declared
 * don'ts are combined with the engine anti-patterns (D68).
 */
function makeTheme(
  design?: Partial<{ identity: string; do: string[]; dont: string[] }>,
  extra?: Partial<{ motif: string }>,
): ResolvedTheme {
  return parseOrThrow(
    resolvedThemeSchema,
    {
      id: "t",
      name: "Test Theme",
      ...(design !== undefined
        ? {
            design: {
              identity: design.identity ?? "TEST IDENTITY",
              ...(design.do !== undefined ? { do: design.do } : {}),
              ...(design.dont !== undefined ? { dont: design.dont } : {}),
            },
          }
        : {}),
      tokens: {
        colors: {
          bg: "#1f2a24",
          surface: "#2b3a31",
          text: "#f3efe6",
          muted: "#cbc6b8",
          accent: "#8a9a5b",
          "accent-strong": "#c2cf95",
          price: "#f0d9a7",
        },
        fontFamilies: { display: "'X', serif", body: "'Inter', sans-serif" },
        radius: { sm: "0.25rem", md: "0.5rem", lg: "1rem", full: "9999px" },
      },
      motion: [{ name: "fade-in", kind: "css" }],
      assets: { backgrounds: [], fonts: [] },
      density: "balanced",
      ...(extra?.motif !== undefined ? { motif: extra.motif } : {}),
    },
    "test theme",
  );
}

describe("describeDesignIntent — DO list (D68)", () => {
  it("includes the theme's declared DOs, framed to grade positively", () => {
    const brief = describeDesignIntent(
      makeTheme({ do: ["frame every board in the truck-art stripe border"] }),
    );
    expect(brief).toContain("frame every board in the truck-art stripe border");
    // Framed as something to reward when visible, distinct from the DON'T framing.
    expect(brief).toMatch(/Declared DOs/i);
    expect(brief).toMatch(/grade positively when you can SEE them honoured/i);
  });

  it("places the DO list before the DON'T list", () => {
    const brief = describeDesignIntent(
      makeTheme({ do: ["DO-MARKER stripe frame"], dont: ["DONT-MARKER no gradients"] }),
    );
    expect(brief.indexOf("DO-MARKER")).toBeGreaterThanOrEqual(0);
    expect(brief.indexOf("DONT-MARKER")).toBeGreaterThan(brief.indexOf("DO-MARKER"));
  });

  it("omits the DO block entirely when the theme declares no DOs", () => {
    const brief = describeDesignIntent(makeTheme({ do: [], dont: ["no gradients"] }));
    expect(brief).not.toMatch(/Declared DOs/i);
  });
});

describe("describeDesignIntent — no silent truncation of the declared brief (D68)", () => {
  it("keeps every declared DO even when there are more than ten", () => {
    const dos = Array.from({ length: 14 }, (_, i) => `DO-${i}`);
    const brief = describeDesignIntent(makeTheme({ do: dos }));
    for (const d of dos) expect(brief).toContain(d);
  });

  it("keeps every DON'T even when theme don'ts plus engine anti-patterns exceed ten", () => {
    const themeDonts = Array.from({ length: 6 }, (_, i) => `THEME-DONT-${i}`);
    const antiPatterns = Array.from({ length: 7 }, (_, i) => `ENGINE-ANTI-${i}`);
    const brief = describeDesignIntent(makeTheme({ dont: themeDonts }), antiPatterns);
    // Neither the theme's own don'ts nor the engine anti-patterns may be crowded out by the other.
    for (const d of themeDonts) expect(brief).toContain(d);
    for (const a of antiPatterns) expect(brief).toContain(a);
  });
});

describe("describeDesignIntent — purity conventions", () => {
  it("names the theme, density and motif without leaking token hex", () => {
    const brief = describeDesignIntent(makeTheme({ do: ["x"] }, { motif: "truck-art" }));
    expect(brief).toContain("Test Theme");
    expect(brief).toContain("truck-art");
    expect(brief).not.toContain("#");
  });
});
