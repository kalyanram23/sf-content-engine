import { describe, expect, it } from "vitest";

import { parseOrThrow } from "../../domain/parse";
import { generateConstraintsSchema, resolvedThemeSchema } from "../../domain/schemas";
import type { PaintRequest } from "../../ports/painter";
import { ICON_GLYPH_NAMES } from "../../theme/icon-glyphs";
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

  it("places the brand on the RIGHT of the masthead band (board title stays left)", () => {
    const lines = brandUserLines({ name: "Acme" }).join("\n");
    expect(lines).toContain("RIGHT side of the masthead band");
    expect(lines).toContain("board title stays on the left");
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

  it("carries the CARD INTERIOR stacking rule (the desc↔price gap fix)", () => {
    const system = buildSystem(testTheme);
    // Name/description/price stack as ONE tight cluster; extra height goes OUTSIDE the cluster.
    expect(system).toContain("CARD INTERIOR");
    expect(system).toContain("ONE TIGHT CLUSTER");
    expect(system).toContain("never a name pinned top-left with its price marooned bottom-right");
  });

  it("fills the screen with big content, not stretched rows (the eval-4 contradiction fix)", () => {
    const system = buildSystem(testTheme);
    // FILL THE SCREEN stays a goal, but the means are large type + content-hugging cards…
    expect(system).toContain("FILL THE SCREEN");
    expect(system).toContain("content-hugging cards");
    expect(system).toContain("never 1fr-stretched or flex-grown");
    // …and the old commands that CAUSED the stretched-cell failure class are gone.
    expect(system).not.toContain("rows STRETCH");
    expect(system).not.toContain("stretched card");
  });

  it("carries the eval-4 visual-audit contract lines (stretched rows, window chrome, markers, wrapped leaders)", () => {
    const system = buildSystem(testTheme);
    // 1. Stretched rows/cells + inflated between-row voids — the biggest visual failure class.
    expect(system).toContain("VERTICAL RHYTHM");
    // 2. TV sign, not an app window — no close glyph / scrollbar / cursor.
    expect(system).toContain("NO WINDOW CHROME");
    // 3. No unexplained marker glyph on an item name without an on-board legend.
    expect(system).toContain("MARKER LEGENDS");
    // 4. A wrapped-name row keeps the same name↔price leader treatment as its neighbours.
    expect(system).toContain("aligns on the last line");
  });

  it("carries the COLUMN BALANCE contract line (never clip one column while a sibling has empty space)", () => {
    const system = buildSystem(testTheme);
    expect(system).toContain("COLUMN BALANCE");
    // Sibling multi-column sections end within about one row of each other, never clipped at the edge.
    expect(system).toContain("sibling columns end within about one row");
    expect(system).toContain("overflow-hidden container");
  });

  it("carries the MASTHEAD contract line (title left / brand right, no invented restaurant name)", () => {
    const system = buildSystem(testTheme);
    expect(system).toContain("MASTHEAD");
    expect(system).toContain("board title (the plan's `title`) on the LEFT");
    expect(system).toContain("NEVER invent a restaurant name, logo, or tagline");
  });

  it("carries the COPY WHITELIST contract line (no invented badges / theme name as copy)", () => {
    const system = buildSystem(testTheme);
    expect(system).toContain("COPY WHITELIST");
    // The filler-badge examples the painter must never invent.
    expect(system).toContain("MADE TO ORDER");
    expect(system).toContain("FRESH · HOT · DAILY");
    // The theme's own name must never leak onto the board as on-screen copy.
    expect(system).toContain("The theme's name must never appear as on-screen copy");
  });

  it("points the image-slot anchoring bullet at the per-request orientation rules", () => {
    const system = buildSystem(testTheme);
    expect(system).toContain("Slot PLACEMENT");
    expect(system).toContain("portrait vs. landscape category heroes");
  });
});

/**
 * The theme exemplar (D66): when a theme's `design.exemplar` carries a gold reference board,
 * buildSystem injects an "EXEMPLAR" section (with a never-copy + adapt-proportions guard) right
 * after the identity/DO/DON'T block. A theme WITHOUT an exemplar produces a byte-identical prompt
 * to before — no drift for other themes.
 */
describe("buildSystem theme exemplar (D66)", () => {
  const exemplarHtml =
    '<div style="height:100vh"><span data-item-id="placeholder-1">Sample Dish</span></div>';
  const themeWithExemplar = parseOrThrow(
    resolvedThemeSchema,
    {
      ...JSON.parse(JSON.stringify(testTheme)),
      design: {
        identity: "TEST IDENTITY",
        do: ["do one"],
        dont: ["dont one"],
        exemplar: { aspect: "9:16", html: exemplarHtml, note: "trimmed gold board" },
      },
    },
    "theme with exemplar",
  );

  it("omits the exemplar section entirely when the theme has none (no drift)", () => {
    expect(buildSystem(testTheme)).not.toContain("EXEMPLAR");
    expect(testTheme.design?.exemplar).toBeUndefined();
  });

  it("injects the exemplar section, its guard, aspect, note, and the HTML when present", () => {
    const system = buildSystem(themeWithExemplar);
    expect(system).toContain("EXEMPLAR — a finished board in this theme");
    // The never-copy guard: take structure/craft, not the placeholder copy.
    expect(system).toContain("STRUCTURE and CRAFT");
    expect(system).toContain("NEVER copy");
    expect(system).toContain("real content comes exclusively from the planned items");
    // The adapt-proportions guard names the exemplar's own aspect.
    expect(system).toContain("adapt the proportions");
    expect(system).toContain("9:16");
    expect(system).toContain("trimmed gold board");
    // The exemplar HTML itself is embedded verbatim.
    expect(system).toContain(exemplarHtml);
  });

  it("places the exemplar after the DO/DON'T block and before the engine design goals", () => {
    const system = buildSystem(themeWithExemplar);
    expect(system.indexOf("DON'T (this theme)")).toBeLessThan(system.indexOf("EXEMPLAR —"));
    expect(system.indexOf("EXEMPLAR —")).toBeLessThan(system.indexOf("DESIGN GOALS"));
  });

  it("keeps the re-paint prompt prefix byte-identical when an exemplar is present (C1 cache prefix)", () => {
    const paint = buildSystem(themeWithExemplar, false);
    const repaint = buildSystem(themeWithExemplar, true);
    const idx = paint.indexOf("- FINAL SELF-CHECK");
    expect(idx).toBeGreaterThan(0);
    expect(repaint.slice(0, idx)).toBe(paint.slice(0, idx));
    // The exemplar lives in the shared, cached prefix.
    expect(paint.indexOf(exemplarHtml)).toBeLessThan(idx);
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
 * Orientation-aware CATEGORY hero + subtitle placement: a landscape board sits the hero photo BESIDE
 * its category title (title + description as a subtitle alongside), a portrait board stacks it ABOVE
 * the title with the description subtitle BELOW. The two branches never leak into each other.
 */
describe("describeRequest orientation-aware category heroes", () => {
  it("gives a landscape board the beside-the-title hero rule (not the portrait one)", () => {
    const user = describeRequest(makeRequest("16:9"));
    expect(user).toContain("LANDSCAPE CATEGORY HEROES");
    expect(user).toContain("BESIDE its category title");
    expect(user).not.toContain("PORTRAIT CATEGORY HEROES");
  });

  it("gives a portrait board the above-the-title hero + subtitle-below rule (not the landscape one)", () => {
    const user = describeRequest(makeRequest("9:16"));
    expect(user).toContain("PORTRAIT CATEGORY HEROES");
    expect(user).toContain("sits ABOVE the category title");
    expect(user).toContain("subtitle sits BELOW the title");
    expect(user).not.toContain("LANDSCAPE CATEGORY HEROES");
  });
});

/**
 * The masthead title line: when the plan screen carries a `title` (stamped by the coverage planner)
 * the user prompt names it explicitly near the plan JSON so the painter renders it in the masthead
 * band. A screen with no title (hand-authored plans) carries no such line.
 */
describe("describeRequest masthead title", () => {
  function titledRequest(): PaintRequest {
    const request = makeRequest("16:9");
    request.planScreen = {
      id: "screen-1",
      title: "Mandi · Non Veg Appetizers",
      sections: [{ title: "MAINS", representation: "list", items: ["a"] }],
    };
    return request;
  }

  it("emits the masthead title line when the plan screen has a title", () => {
    expect(describeRequest(titledRequest())).toContain(
      'Masthead title: "Mandi · Non Veg Appetizers"',
    );
  });

  it("omits the masthead title line when the plan screen has no title", () => {
    expect(describeRequest(makeRequest("16:9"))).not.toContain("Masthead title:");
  });
});

/**
 * Board-family context: a board that belongs to a multi-screen SET is told its position and that it
 * shares ONE visual system with its siblings (masthead, section headers, price treatment, canvas
 * background). A lone board (no `board` field) carries no such directive.
 */
describe("describeRequest board family", () => {
  it("emits the BOARD FAMILY directive with the screen position when board context is present", () => {
    const request: PaintRequest = { ...makeRequest("16:9"), board: { index: 2, total: 3 } };
    const user = describeRequest(request);
    expect(user).toContain("BOARD FAMILY — this is screen 2 of 3");
    expect(user).toContain("share ONE visual system");
    expect(user).toContain("title left / brand right");
  });

  it("omits the BOARD FAMILY directive for a lone board (no board context)", () => {
    expect(describeRequest(makeRequest("16:9"))).not.toContain("BOARD FAMILY");
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
 * The category-images requirement: every category on a board carries a visual anchor. The engine
 * contract requires a `data-image-slot` marker on every slot container (per-category name, or
 * "shared" for the board-level slot), describes the deliberate food-icon panel for a photo-less
 * category, and scopes PHOTO TRUTH to per-item cards so it composes with the icon-slot exception.
 */
describe("buildSystem category-image contract", () => {
  it("requires a data-image-slot marker on every slot container (per-category + shared)", () => {
    const system = buildSystem(testTheme);
    expect(system).toContain('data-image-slot="<category name>"');
    expect(system).toContain('data-image-slot="shared"');
    // The per-category food-icon panel is one of the enumerated container types.
    expect(system).toContain("a per-category food-icon panel");
  });

  it("scopes PHOTO TRUTH to per-item cards so it composes with category icon slots", () => {
    const system = buildSystem(testTheme);
    expect(system).toContain("PHOTO TRUTH (per-item cards)");
    expect(system).toContain("This governs per-ITEM cards ONLY");
  });

  it("no longer emits the icon-render guidance in the always-on contract (moved to the per-section slot line, A1)", () => {
    const system = buildSystem(testTheme);
    // The 13-name glyph list, the icon-panel proportion rule, and the empty-glyph marker are now
    // emitted ONLY in the conditional per-section icon-slot line — never inert in the system prompt.
    expect(system).not.toContain(ICON_GLYPH_NAMES.join(", "));
    expect(system).not.toContain("ICON PANEL PROPORTION");
    expect(system).not.toContain('<svg data-icon="<name>"></svg>');
    // PILLS & VARIANT LABELS is now gated on the presence of sizes/variants (a user-prompt line).
    expect(system).not.toContain("PILLS & VARIANT LABELS");
  });
});

/**
 * Re-paint self-check swap (C1): on a re-paint the from-scratch "re-check the WHOLE board against
 * this contract" self-check contradicts the minimal-change instruction, so `buildSystem(theme, true)`
 * swaps ONLY the tail FINAL SELF-CHECK bullet for a scoped one (fix each listed finding, no new
 * violation, don't restyle what the findings don't name). It stays at the tail so the whole prompt
 * PREFIX is byte-identical between paint and re-paint (OpenRouter prompt-cache prefix). The D34
 * item-preservation safeguard survives both branches.
 */
describe("buildSystem re-paint self-check swap (C1)", () => {
  it("swaps only the tail FINAL SELF-CHECK bullet; the whole prompt prefix stays byte-identical", () => {
    const paint = buildSystem(testTheme, false);
    const repaint = buildSystem(testTheme, true);
    expect(paint).not.toBe(repaint);
    // The prefix up to the FINAL SELF-CHECK bullet is identical (prompt-cache prefix invariant).
    const idx = paint.indexOf("- FINAL SELF-CHECK");
    expect(idx).toBeGreaterThan(0);
    expect(repaint.indexOf("- FINAL SELF-CHECK")).toBe(idx);
    expect(repaint.slice(0, idx)).toBe(paint.slice(0, idx));
  });

  it("first paint keeps the whole-board re-audit line; re-paint uses the scoped, finding-only line", () => {
    const paint = buildSystem(testTheme, false);
    const repaint = buildSystem(testTheme, true);
    expect(paint).toContain("- FINAL SELF-CHECK: before returning, silently re-check");
    expect(paint).not.toContain("FINAL SELF-CHECK (re-paint)");
    expect(repaint).toContain(
      "- FINAL SELF-CHECK (re-paint): confirm your edit resolves EACH listed finding",
    );
    expect(repaint).toContain("do NOT re-audit or restyle parts the findings do not name");
    expect(repaint).not.toContain("silently re-check your HTML against this contract");
    // D34 item-preservation safeguard is kept in BOTH branches.
    expect(paint).toContain("NEVER drop, summarise, or shorten a planned item");
    expect(repaint).toContain("NEVER drop, summarise, or shorten a planned item");
  });

  it("defaults isRepaint to false (back-compat with single-arg callers)", () => {
    expect(buildSystem(testTheme)).toBe(buildSystem(testTheme, false));
  });
});

/**
 * The per-section image-slot directives (the category-images requirement): a comfortable board's
 * sections each get a slot line — a CATEGORY PHOTO PANEL for a category with photos, else a
 * deliberate FOOD-ICON panel — each tagged with data-image-slot="<category name>". The board-level
 * shared slot (dense/packed / matrix hero) is tagged data-image-slot="shared".
 */
describe("describeRequest per-category image slots", () => {
  function sectionSlotRequest(): PaintRequest {
    const request = makeRequest("16:9");
    request.planScreen = {
      id: "screen-1",
      densityTier: "comfortable",
      sections: [
        {
          title: "MANDI",
          representation: "grid",
          items: ["a"],
          imageSlot: { kind: "photos", items: ["a"] },
        },
        {
          title: "DESSERTS",
          representation: "grid",
          items: ["b"],
          imageSlot: { kind: "icon", items: [] },
        },
      ],
    };
    request.items = [
      {
        id: "a",
        name: "Chicken Mandi",
        category: "MANDI",
        available: true,
        price: 12,
        images: ["data:image/png;base64,AAAA"],
      },
      { id: "b", name: "Kunafa", category: "DESSERTS", available: true, price: 8 },
    ];
    return request;
  }

  it("renders a photos slot line tagged with the category name", () => {
    const user = describeRequest(sectionSlotRequest());
    expect(user).toContain('Section image slot — "MANDI"');
    expect(user).toContain('data-image-slot="MANDI"');
    expect(user).toContain("CATEGORY PHOTO PANEL");
  });

  it("renders a food-icon slot line for a photo-less category (never a missing-photo box)", () => {
    const user = describeRequest(sectionSlotRequest());
    expect(user).toContain('Section image slot — "DESSERTS"');
    expect(user).toContain('data-image-slot="DESSERTS"');
    expect(user).toContain("FOOD-ICON panel");
    expect(user).toContain("NEVER a blank or missing-photo box");
  });

  it("carries the curated glyph marker + name list + proportion in the icon-slot line (moved from the always-on contract, A1)", () => {
    const user = describeRequest(sectionSlotRequest());
    // The empty glyph marker, the "no hand-drawn art" rail, the offered name list, and the panel
    // proportion rule now live ONLY on the per-section icon-slot line (not the system prompt).
    expect(user).toContain('<svg data-icon="<name>"></svg>');
    expect(user).toContain("NEVER hand-draw food art");
    expect(user).toContain("platter-generic");
    expect(user).toContain(ICON_GLYPH_NAMES.join(", "));
    expect(user).toContain("ICON PANEL PROPORTION");
  });

  it("emits the 13-name glyph list EXACTLY ONCE across the assembled system + user prompt (de-dup, A1)", () => {
    const glyphList = ICON_GLYPH_NAMES.join(", ");
    const assembled = `${buildSystem(testTheme)}\n${describeRequest(sectionSlotRequest())}`;
    expect(assembled.split(glyphList).length - 1).toBe(1);
  });

  it('tags the board-level shared slot data-image-slot="shared"', () => {
    const request = makeRequest("16:9");
    request.planScreen = {
      id: "screen-1",
      densityTier: "packed",
      imageSlot: { items: ["a"] },
      sections: [{ title: "MAINS", representation: "list", items: ["a"] }],
    };
    request.items = [
      {
        id: "a",
        name: "Dish A",
        category: "MAINS",
        available: true,
        price: 9,
        images: ["data:image/png;base64,AAAA"],
      },
    ];
    const user = describeRequest(request);
    expect(user).toContain("board-level shared");
    expect(user).toContain('data-image-slot="shared"');
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
 * disappears from "Item ids WITH a photo". The allowlist is now the SOLE per-item photo signal
 * (the redundant per-item `photoCount` was dropped, B5). Pinned so a future refactor can't
 * reintroduce a second source of photo truth.
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
    // The redundant per-item photoCount is gone — the allowlist is the only photo signal now.
    expect(user).not.toContain("photoCount");
  });
});

/**
 * Slim plan echo (B1 + B5): the plan JSON echoed to the painter drops the redundant board-level
 * `imageSlot` (the dedicated shared-slot directive carries its ids + semantics) and each NON-matrix
 * section's `layoutHint` (a stale free-text hint the LAYOUT STRATEGY now supersedes). A matrix
 * section KEEPS its layoutHint because MATRIX_FIRST_STRATEGY textually references it.
 */
describe("describeRequest slim plan echo", () => {
  const planLine = (user: string): string =>
    user.split("\n").find((l) => l.startsWith("Plan: ")) ?? "";

  it("omits a non-matrix section's layoutHint from the serialized plan", () => {
    const request = makeRequest("16:9");
    request.planScreen = {
      id: "screen-1",
      sections: [
        {
          title: "CURRIES",
          representation: "grid",
          items: ["a"],
          layoutHint: "two-column photo grid",
        },
      ],
    };
    const plan = planLine(describeRequest(request));
    expect(plan).toContain("Plan: ");
    expect(plan).not.toContain("layoutHint");
    expect(plan).not.toContain("two-column photo grid");
  });

  it("keeps a matrix-representation section's layoutHint in the serialized plan", () => {
    const request = makeRequest("16:9");
    request.planScreen = {
      id: "screen-1",
      sections: [
        {
          title: "BIRYANI & PULAV",
          representation: "matrix",
          items: ["a"],
          layoutHint: "rows = base dish, columns = Biryani | Pulav",
        },
      ],
    };
    const plan = planLine(describeRequest(request));
    expect(plan).toContain("layoutHint");
    expect(plan).toContain("rows = base dish, columns = Biryani | Pulav");
  });

  it("keeps the layoutHint of a section carrying a computed matrix even if its representation is grid", () => {
    const request = makeRequest("16:9");
    request.planScreen = {
      id: "screen-1",
      sections: [
        {
          title: "PRICES",
          representation: "grid",
          items: ["a"],
          layoutHint: "a computed price table",
          matrix: { columns: ["Biryani"], rows: [{ label: "Chicken", cells: ["a"] }] },
        },
      ],
    };
    expect(planLine(describeRequest(request))).toContain("a computed price table");
  });

  it("strips the board-level imageSlot from the serialized plan but keeps its ids in the shared-slot directive", () => {
    const request = makeRequest("16:9");
    request.planScreen = {
      id: "screen-1",
      imageSlot: { categoryId: "Mandi", items: ["a"] },
      sections: [{ title: "MAINS", representation: "grid", items: ["a"] }],
    };
    const user = describeRequest(request);
    // The raw plan echo no longer carries the imageSlot object …
    expect(planLine(user)).not.toContain("imageSlot");
    // … but the dedicated directive still carries the ids + placement/caption semantics.
    expect(user).toContain("Image slot (board-level shared)");
    expect(user).toContain('["a"]');
  });
});

/**
 * Slim item payload (B2 + B5): the serialized Items JSON drops the off-plan per-item `category`
 * (a mis-cased upstream taxonomy the COPY WHITELIST could otherwise bless as a competing heading)
 * and the redundant `photoCount`, while keeping the item's identity/name/price.
 */
describe("describeRequest slim item payload", () => {
  it("drops the per-item category and photoCount from the serialized Items JSON", () => {
    const request = makeRequest("16:9");
    request.items = [
      {
        id: "a",
        name: "Dish A",
        category: "Falooda'S",
        available: true,
        price: 9.5,
        images: ["data:image/png;base64,AAAA"],
      },
    ];
    const itemsLine =
      describeRequest(request)
        .split("\n")
        .find((l) => l.startsWith("Items: ")) ?? "";
    expect(itemsLine).toContain("Items: ");
    expect(itemsLine).not.toContain("category");
    expect(itemsLine).not.toContain("Falooda");
    expect(itemsLine).not.toContain("photoCount");
    // The item itself is still present with its id / name / price.
    expect(itemsLine).toContain('"id":"a"');
    expect(itemsLine).toContain('"name":"Dish A"');
    expect(itemsLine).toContain('"price":9.5');
  });
});

/**
 * PILLS & VARIANT LABELS gate (A1): the pill/variant composition directive is emitted ONLY when at
 * least one item carries sizes or variants — a board of plain single-price items never sees it.
 */
describe("describeRequest PILLS gate", () => {
  it("emits the PILLS directive when an item carries sizes", () => {
    const request = makeRequest("16:9");
    request.items = [
      {
        id: "a",
        name: "Pizza",
        category: "mains",
        available: true,
        sizes: [{ label: "10in", price: 12 }],
      },
    ];
    expect(describeRequest(request)).toContain("PILLS & VARIANT LABELS");
  });

  it("emits the PILLS directive when an item carries variants", () => {
    const request = makeRequest("16:9");
    request.items = [
      {
        id: "a",
        name: "Curry",
        category: "mains",
        available: true,
        price: 9,
        variants: [{ label: "Paneer" }, { label: "Chicken" }],
      },
    ];
    expect(describeRequest(request)).toContain("PILLS & VARIANT LABELS");
  });

  it("omits the PILLS directive when no item has sizes or variants", () => {
    expect(describeRequest(makeRequest("16:9"))).not.toContain("PILLS & VARIANT LABELS");
  });
});

/**
 * Shared-slot caption (B4): the board-level shared photo slot is captioned with its single category,
 * but when its photo items span MORE THAN ONE category a one-category caption would mislabel the
 * band, so the caption clause is dropped (the panel stays anchored to its section either way).
 */
describe("describeRequest shared-slot caption", () => {
  function twoCategoryItems(): PaintRequest["items"] {
    return [
      {
        id: "a",
        name: "Chicken Mandi",
        category: "Mandi",
        available: true,
        price: 12,
        images: ["data:image/png;base64,AAAA"],
      },
      {
        id: "b",
        name: "Grilled Fish",
        category: "Grills",
        available: true,
        price: 15,
        images: ["data:image/png;base64,BBBB"],
      },
    ];
  }

  it("drops the caption clause when the shared slot spans more than one category", () => {
    const request = makeRequest("16:9");
    request.planScreen = {
      id: "screen-1",
      imageSlot: { items: ["a", "b"] },
      sections: [
        { title: "MANDI", representation: "grid", items: ["a"] },
        { title: "GRILLS", representation: "grid", items: ["b"] },
      ],
    };
    request.items = twoCategoryItems();
    const user = describeRequest(request);
    expect(user).toContain("Image slot (board-level shared)");
    expect(user).not.toContain('and captioned "');
  });

  it("keeps the caption clause when the shared slot resolves to a single category", () => {
    const request = makeRequest("16:9");
    request.planScreen = {
      id: "screen-1",
      imageSlot: { items: ["a"] },
      sections: [
        { title: "MANDI", representation: "grid", items: ["a"] },
        { title: "GRILLS", representation: "grid", items: ["b"] },
      ],
    };
    request.items = twoCategoryItems();
    expect(describeRequest(request)).toContain('and captioned "Mandi"');
  });
});

/**
 * Priceless items (D29-review Fix 3): an item with no renderable price — menu-lint's hide policy
 * strips $0/missing prices upstream, or it is a genuine price-on-request item — is MARKED
 * "priceless":true in the digest JSON, and a directive tells the painter to render it name-only,
 * never an empty price chip. A board whose items are all priced carries neither.
 */
describe("describeRequest priceless items", () => {
  function pricelessRequest(): PaintRequest {
    const request = makeRequest("16:9");
    request.planScreen = {
      id: "screen-1",
      sections: [{ title: "MAINS", representation: "list", items: ["a", "b"] }],
    };
    request.items = [
      { id: "a", name: "Market Fish", category: "mains", available: true },
      { id: "b", name: "Dish B", category: "mains", available: true, price: 11 },
    ];
    return request;
  }

  it('marks a priceless item "priceless":true in the digest and carries the name-only directive', () => {
    const user = describeRequest(pricelessRequest());
    expect(user).toContain('"priceless":true');
    expect(user).toContain("PRICELESS ITEMS");
    expect(user).toContain("NAME-ONLY");
    expect(user).toContain("never a hollow price slot");
  });

  it("omits the priceless marker + directive when every item is priced", () => {
    const user = describeRequest(makeRequest("16:9"));
    expect(user).not.toContain('"priceless":true');
    expect(user).not.toContain("PRICELESS ITEMS");
  });
});
