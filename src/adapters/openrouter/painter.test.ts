import { describe, expect, it } from "vitest";

import { parseOrThrow } from "../../domain/parse";
import { generateConstraintsSchema, resolvedThemeSchema } from "../../domain/schemas";
import type { PaintRequest } from "../../ports/painter";
import {
  brandUserLines,
  buildSystem,
  describeLayoutStrategy,
  describeRequest,
  extractScreenHtml,
} from "./painter";

/**
 * Hermetic (no network): guards how we pull the screen markup out of a model response. The painter
 * model occasionally disobeys "return ONLY the HTML, no fences" — on a re-paint it can emit its QA
 * reasoning as a prose preamble before a ```html block. None of that may leak into the page.
 */
describe("extractScreenHtml", () => {
  it("returns bare HTML untouched", () => {
    expect(extractScreenHtml("<div>hi</div>")).toBe("<div>hi</div>");
  });

  it("strips a leading ```html fence", () => {
    expect(extractScreenHtml("```html\n<section>x</section>\n```")).toBe("<section>x</section>");
  });

  it("ignores a prose preamble before a fenced block (the board-2 regression)", () => {
    const raw =
      "Looking at the two QA findings: 1. Contrast 1.38:1 on a span. 2. Overflow 0x369px. Fix: lock root.\n\n" +
      '```html\n<div class="root"><h1>VEG CURRIES</h1></div>\n```';
    expect(extractScreenHtml(raw)).toBe('<div class="root"><h1>VEG CURRIES</h1></div>');
  });

  it("drops prose before the first tag even when the model omits the fence", () => {
    const raw = "Here is the screen: <main><h1>BIRYANI & PULAV</h1></main>";
    expect(extractScreenHtml(raw)).toBe("<main><h1>BIRYANI & PULAV</h1></main>");
  });

  it("strips a dangling ```html marker with no closing fence", () => {
    expect(extractScreenHtml("Sure!\n```html\n<div>x</div>")).toBe("<div>x</div>");
  });
});

/**
 * The per-board layout guidance must make representation/layoutHint authoritative: a matrix/table
 * board gets matrix-first guidance with a single shared hero (the photo-grid-per-item language is
 * suppressed), while any other board keeps the photo-grid + per-section hero language. Proves the
 * conditional branches both ways so neither path regresses.
 */
describe("describeLayoutStrategy", () => {
  const matrixBoard = {
    id: "screen-1",
    sections: [
      {
        title: "BIRYANI & PULAV",
        representation: "matrix" as const,
        items: ["a1", "a2", "a3"],
        layoutHint: "rows = base dish, columns = Biryani | Pulav",
      },
    ],
  };
  const photoBoard = {
    id: "screen-2",
    sections: [{ title: "CURRIES", representation: "grid" as const, items: ["b1", "b2"] }],
  };

  it("emits matrix-first guidance + a single shared hero, suppressing the photo-grid language", () => {
    const s = describeLayoutStrategy(matrixBoard);
    expect(s).toContain("MATRIX/TABLE FIRST");
    expect(s).toContain("ONE shared compact rotating hero");
    expect(s).not.toContain("PHOTO-LED GRID");
    expect(s).not.toContain("Give EVERY item its own large card");
  });

  it("emits photo-grid + per-section hero language for a non-matrix board", () => {
    const s = describeLayoutStrategy(photoBoard);
    expect(s).toContain("PHOTO-LED GRID");
    expect(s).toContain("Give EVERY item its own large card");
    expect(s).toContain("rotating hero");
    expect(s).not.toContain("MATRIX/TABLE FIRST");
  });

  it("detects a matrix board from the layoutHint even when representation is not matrix", () => {
    const board = {
      id: "screen-3",
      sections: [
        {
          title: "PRICES",
          representation: "grid" as const,
          items: ["c1"],
          layoutHint: "a price table: rows x columns",
        },
      ],
    };
    expect(describeLayoutStrategy(board)).toContain("MATRIX/TABLE FIRST");
  });
});

/**
 * The brand-header instruction block appended to the painter's user prompt when a run has brand
 * content. Uses the item-photo placeholder scheme (NO src) so the large logo data-URI never
 * passes through the model.
 */
describe("brandUserLines", () => {
  it("instructs the no-src placeholder and includes name/tagline/alt", () => {
    const lines = brandUserLines({
      logo: { src: "data:image/png;base64,AAAA", alt: "Acme logo" },
      name: "Acme Diner",
      tagline: "Fresh daily",
    }).join("\n");
    expect(lines).toContain("data-brand-logo");
    expect(lines).toContain("NO src");
    expect(lines).toContain("Acme Diner");
    expect(lines).toContain("Fresh daily");
    expect(lines).toContain("Acme logo");
  });

  it("omits absent fields", () => {
    const lines = brandUserLines({ name: "Acme" }).join("\n");
    expect(lines).toContain("Acme");
    expect(lines).not.toContain("Tagline");
  });

  it("omits the logo placeholder instruction when there is no logo", () => {
    const lines = brandUserLines({ name: "Acme", tagline: "Fresh" }).join("\n");
    expect(lines).not.toContain("data-brand-logo");
    expect(lines).toContain("Acme");
    expect(lines).toContain("Fresh");
  });
});

const testTheme = parseOrThrow(
  resolvedThemeSchema,
  {
    id: "t",
    name: "Test Theme",
    design: { identity: "TEST IDENTITY", do: ["do one"], dont: ["dont one"] },
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
  },
  "test theme",
);

function makeRequest(aspect: "16:9" | "9:16"): PaintRequest {
  return {
    planScreen: {
      id: "screen-1",
      sections: [{ title: "MAINS", representation: "list", items: ["a"] }],
    },
    items: [{ id: "a", name: "Dish A", category: "mains", available: true, price: 9.5 }],
    theme: testTheme,
    constraints: parseOrThrow(generateConstraintsSchema, { aspect }, "constraints"),
    viewport: aspect === "9:16" ? { width: 1080, height: 1920 } : { width: 1920, height: 1080 },
  };
}

/**
 * The painter system prompt must frame the output as a FIXED signage poster (not a web page) and
 * stay polarity-neutral about contrast — the old dark-only wording ("on the dark theme surfaces")
 * and the landscape-hardcoded "1920x1080" literal would mislead the two light themes and 9:16
 * boards. These pins guard that the framing/wording rewrites don't silently regress.
 */
describe("buildSystem", () => {
  it("frames the canvas as a fixed, non-scrolling poster", () => {
    const system = buildSystem(testTheme);
    expect(system).toContain("FIXED, non-scrolling POSTER");
    expect(system).toContain("not a web page");
  });

  it("does not hardcode a landscape canvas or dark-only contrast wording", () => {
    const system = buildSystem(testTheme);
    expect(system).not.toContain("1920x1080");
    expect(system).not.toContain("on the dark theme surfaces");
  });

  it("states the polarity-neutral contrast rule (both dark and light surfaces)", () => {
    const system = buildSystem(testTheme);
    expect(system).toContain("on a dark surface");
    expect(system).toContain("on a light surface");
  });

  it("allows a rem-based hard offset shadow as the one arbitrary-value exception", () => {
    expect(buildSystem(testTheme)).toContain("shadow-[0.5rem_0.5rem_0_var(--color-text)]");
  });
});

/**
 * The user prompt carries the per-request aspect: only a 9:16 board gets the PORTRAIT composition
 * guidance (single-column vertical flow), so a landscape board is never told to stack into one
 * column. The aspect is per-request, which is why this lives in describeRequest, not buildSystem.
 */
describe("describeRequest aspect guidance", () => {
  it("adds PORTRAIT composition guidance for a 9:16 board", () => {
    const user = describeRequest(makeRequest("9:16"));
    expect(user).toContain("PORTRAIT (9:16) COMPOSITION");
    expect(user).toContain("single-column VERTICAL flow");
  });

  it("omits PORTRAIT guidance for a 16:9 board", () => {
    const user = describeRequest(makeRequest("16:9"));
    expect(user).not.toContain("PORTRAIT (9:16) COMPOSITION");
  });
});
