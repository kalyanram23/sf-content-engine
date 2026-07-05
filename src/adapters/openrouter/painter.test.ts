import { describe, expect, it } from "vitest";

import { parseOrThrow } from "../../domain/parse";
import { generateConstraintsSchema, resolvedThemeSchema } from "../../domain/schemas";
import type { PaintRequest } from "../../ports/painter";
import { FindingKind, makeFinding } from "../../qa/finding";
import {
  REF_INSTRUCTION,
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
    expect(s).toContain("ONE shared rotating hero");
    // The hero has a concrete size floor (D25/D26 review fix): a real anchor, never a sliver.
    expect(s).toContain("12–15% of the canvas area");
    expect(s).toContain("never a corner thumbnail");
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

  it("carries the photo-truth and universal card/row discipline contract lines", () => {
    const system = buildSystem(testTheme);
    // A photo-less item gets a text-only treatment — never a placeholder image region.
    expect(system).toContain("PHOTO TRUTH");
    // Cards hug their content in every register; name+price read as one connected unit.
    expect(system).toContain("CARD & ROW DISCIPLINE");
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

  it("directs a portrait board to fill the full height top-to-bottom (D33)", () => {
    const user = describeRequest(makeRequest("9:16"));
    expect(user).toContain("PORTRAIT FILL — TOP TO BOTTOM");
    expect(user).toContain("reaches the BOTTOM edge");
  });

  it("omits PORTRAIT guidance for a 16:9 board", () => {
    const user = describeRequest(makeRequest("16:9"));
    expect(user).not.toContain("PORTRAIT (9:16) COMPOSITION");
    expect(user).not.toContain("PORTRAIT FILL");
  });
});

/**
 * The DENSITY IDIOM directive (D30): a `dense`/`packed` board must switch to a compact multi-column
 * price-list register (suppress heroes/whitespace, truncate or drop descriptions, thumbnail-only or
 * no photos). A `comfortable` board (or an absent tier) keeps its normal blueprint — no directive.
 */
describe("describeRequest density idiom (D30)", () => {
  const withTier = (tier: "comfortable" | "dense" | "packed"): PaintRequest => ({
    ...makeRequest("16:9"),
    densityTier: tier,
  });

  it("omits the directive for a comfortable board and an absent tier", () => {
    expect(describeRequest(makeRequest("16:9"))).not.toContain("DENSITY —");
    expect(describeRequest(withTier("comfortable"))).not.toContain("DENSITY —");
  });

  it("injects the compact register for a dense board (multi-column, truncate descriptions)", () => {
    const user = describeRequest(withTier("dense"));
    expect(user).toContain("DENSITY — DENSE BOARD");
    expect(user).toContain("MULTI-COLUMN");
    expect(user).toContain("TRUNCATE");
  });

  it("drops photos and descriptions for a packed board", () => {
    const user = describeRequest(withTier("packed"));
    expect(user).toContain("DENSITY — PACKED BOARD");
    expect(user).toContain("NO per-item photos");
    expect(user).toContain("DROP item descriptions");
  });
});

/**
 * The SPACE & SCALE directive (D33) — the mirror of the D30 dense idiom. A `comfortable` board's
 * failure mode is dead space, so it is told to scale content up and pack the canvas intentionally
 * (no empty hero zones, cards hug their content, spare space → a photo). `dense`/`packed`/absent
 * keep the density idiom or the generic minimums instead.
 */
describe("describeRequest sparse register (D33)", () => {
  const withTier = (tier: "comfortable" | "dense" | "packed"): PaintRequest => ({
    ...makeRequest("16:9"),
    densityTier: tier,
  });

  it("injects the SPACE & SCALE directive for a comfortable board", () => {
    const user = describeRequest(withTier("comfortable"));
    expect(user).toContain("SPACE & SCALE — COMFORTABLE BOARD");
    expect(user).toContain("NO EMPTY HERO ZONES");
    expect(user).toContain("CARDS HUG THEIR CONTENT");
    expect(user).toContain("SPARE SPACE BECOMES A PHOTO");
  });

  it("a comfortable board gets the sparse directive but NOT the dense one", () => {
    const user = describeRequest(withTier("comfortable"));
    expect(user).toContain("SPACE & SCALE");
    expect(user).not.toContain("DENSITY —");
  });

  it("omits the sparse directive for a dense or packed board (density idiom owns those)", () => {
    expect(describeRequest(withTier("dense"))).not.toContain("SPACE & SCALE");
    expect(describeRequest(withTier("packed"))).not.toContain("SPACE & SCALE");
  });

  it("omits it when no tier is set (falls back to the generic minimums)", () => {
    expect(describeRequest(makeRequest("16:9"))).not.toContain("SPACE & SCALE");
  });
});

/**
 * The image slot must render as a CATEGORY-anchored panel captioned with its category name (D33) —
 * never a free-floating hero. The caption resolves from the slot's categoryId, then the shared item
 * category. The engine contract carries the always-on anchoring rule.
 */
describe("image slot anchoring (D33)", () => {
  function slotRequest(slot: PaintRequest["planScreen"]["imageSlot"]): PaintRequest {
    const request = makeRequest("16:9");
    request.planScreen = {
      id: "screen-1",
      ...(slot !== undefined ? { imageSlot: slot } : {}),
      sections: [{ title: "MAINS", representation: "grid", items: ["a"] }],
    };
    request.items = [
      {
        id: "a",
        name: "Chicken Mandi",
        category: "Mandi",
        available: true,
        price: 12,
        images: ["data:image/png;base64,AAAA"],
      },
    ];
    return request;
  }

  it("captions the slot with its categoryId and forbids a free-floating hero", () => {
    const user = describeRequest(slotRequest({ categoryId: "Mandi", items: ["a"] }));
    expect(user).toContain("CATEGORY PHOTO PANEL");
    expect(user).toContain('captioned "Mandi"');
    expect(user).toContain("NEVER a free-floating hero");
  });

  it("falls back to the shared item category when the slot has no categoryId", () => {
    const user = describeRequest(slotRequest({ items: ["a"] }));
    expect(user).toContain('captioned "Mandi"');
  });

  it("the engine contract carries the always-on image-slot anchoring + caption rule", () => {
    const system = buildSystem(testTheme);
    expect(system).toContain("IMAGE SLOT / PHOTO HERO ANCHORING");
    expect(system).toContain("CAPTION it with that section's category name");
  });
});

/**
 * The re-paint block must (1) carry element-anchored findings (the serialized helper, not the old
 * stripped JSON) and (2) order the bulky Previous HTML FIRST with the actionable instruction +
 * findings LAST, so the model doesn't have to read past a 20KB blob to reach what to fix (Anthropic
 * long-context guidance). Pinned so a refactor can't re-bury the instructions or drop the anchors.
 */
describe("describeRequest re-paint block", () => {
  const PREV_HTML = '<main data-prev="1"><h1>MAINS</h1></main>';
  const findings = [
    makeFinding({
      kind: FindingKind.Overflow,
      source: "deterministic",
      severity: "major",
      tag: "layout",
      message: "Content overflows the screen (overshoot 0x26px).",
      data: { overshootX: 0, overshootY: 26, overflowing: ['[data-item-id="a"]'] },
    }),
  ];
  function repaintRequest(): PaintRequest {
    return { ...makeRequest("16:9"), previousHtml: PREV_HTML, findings };
  }

  it("carries element-anchored findings, not the old stripped JSON", () => {
    const user = describeRequest(repaintRequest());
    expect(user).toContain("[major] overflow");
    expect(user).toContain("overshootY=26");
    expect(user).toContain('overflowing=[data-item-id="a"]');
    // The pre-change JSON.stringify shape must be gone.
    expect(user).not.toContain('"kind":"overflow"');
  });

  it("puts the Previous HTML first and the instruction + findings + ref line last", () => {
    const user = describeRequest(repaintRequest());
    expect(user).toContain("Previous HTML (your last output):");
    expect(user).toContain(PREV_HTML);
    // Previous HTML comes BEFORE the actionable instruction.
    expect(user.indexOf(PREV_HTML)).toBeLessThan(user.indexOf("This is a RE-PAINT."));
    // Nothing after the instruction re-embeds the HTML blob — it is the tail of the prompt.
    const tail = user.slice(user.indexOf("This is a RE-PAINT."));
    expect(tail).not.toContain(PREV_HTML);
    // The prompt ends on the ref-resolution instruction.
    expect(user.endsWith(REF_INSTRUCTION)).toBe(true);
  });
});

/**
 * Photo truth (D25-review fix 1): the painter's photo allowlist derives from `item.images` at
 * prompt-build time, so once fetchImages DROPS a failed ref the prompt self-corrects — the item
 * disappears from "Item ids WITH a photo" and its photoCount reads 0. Pinned so a future refactor
 * can't reintroduce a second source of photo truth.
 */
describe("describeRequest photo allowlist", () => {
  it("lists only items that still carry images after fetch", () => {
    const request = makeRequest("16:9");
    request.planScreen = {
      id: "screen-1",
      sections: [{ title: "MAINS", representation: "grid", items: ["a", "b"] }],
    };
    request.items = [
      {
        id: "a",
        name: "Dish A",
        category: "mains",
        available: true,
        price: 9.5,
        images: ["data:image/png;base64,AAAA"],
      },
      // b's photo failed to fetch — the node dropped its images entirely.
      { id: "b", name: "Dish B", category: "mains", available: true, price: 11 },
    ];
    const user = describeRequest(request);
    expect(user).toContain("Item ids WITH a photo (only these may use <img>): a");
    expect(user).not.toMatch(/WITH a photo[^\n]*b/);
    expect(user).toContain('"photoCount":1');
    expect(user).toContain('"photoCount":0');
  });
});
