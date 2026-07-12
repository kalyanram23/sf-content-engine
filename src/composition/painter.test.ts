import { describe, expect, it } from "vitest";

import type { CompositionResponse } from "../domain/contracts";
import { parseOrThrow } from "../domain/parse";
import { resolvedThemeSchema } from "../domain/schemas";
import type { PlanScreen, QaFinding, ResolvedTheme } from "../domain/types";
import type { PaintRequest, Painter } from "../ports/index";
import { fixtures } from "../testing/fixtures/index";
import { builtinVocabularies } from "../vocabularies/index";
import { AutoPainter } from "./auto-painter";
import { CompositionPainter } from "./painter";

const staticComposition: CompositionResponse = { title: "Test Board", blocks: [] };

const fakeComposer = () => {
  const calls: unknown[] = [];
  return {
    calls,
    compose: async (req: unknown) => {
      calls.push(req);
      return staticComposition;
    },
  };
};

const fakeMeasure = {
  measure: async ({ html }: { html: string }) => {
    const keys = [...html.matchAll(/data-mk="([^"]+)"/g)].map((m) => m[1]!);
    return Object.fromEntries(keys.map((k) => [k, 28]));
  },
};

// A minimal dhaba-like resolved theme; `vocabulary` is spread conditionally
// (exactOptionalPropertyTypes) so `makeRequest()` yields a plain (vocabulary-less) theme.
function makeTheme(vocabulary?: string): ResolvedTheme {
  return parseOrThrow(
    resolvedThemeSchema,
    {
      id: "dhaba-test",
      name: "Dhaba Test",
      tokens: {
        colors: {
          bg: "#f8ecd4",
          surface: "#ffffff",
          text: "#2a1a0e",
          muted: "#57503f",
          accent: "#c22415",
          price: "#c22415",
          chip: "#0d6e5c",
          stripe: "#f2b53a",
        },
        fontFamilies: { display: "'Shrikhand', serif", body: "'Archivo', sans-serif" },
        radius: { sm: "0px", md: "0px", lg: "0px", full: "9999px" },
      },
      motion: [{ name: "fade-in", kind: "css" }],
      density: "balanced",
      ...(vocabulary !== undefined ? { vocabulary } : {}),
    },
    "test theme",
  );
}

// A real PaintRequest from the repo fixtures: the sample plan's first screen (PIZZAS/SIDES/CURRIES
// — ≥2 sections) + its matching canonical items, painted at a landscape viewport (exercises the
// measured column path via `fakeMeasure`). `vocabulary` is spread conditionally.
function makeRequest(overrides?: { vocabulary?: string }): PaintRequest {
  const planScreen: PlanScreen = fixtures.plan.screens[0]!;
  return {
    planScreen,
    items: fixtures.menu,
    theme: makeTheme(overrides?.vocabulary),
    constraints: fixtures.input.constraints,
    viewport: { width: 1920, height: 1080 },
  };
}

describe("CompositionPainter", () => {
  it("composes then renders an engine-legal board with full coverage", async () => {
    const composer = fakeComposer();
    const painter = new CompositionPainter({
      composer,
      vocabularies: builtinVocabularies(),
      browser: fakeMeasure,
    });
    const html = await painter.paint(makeRequest({ vocabulary: "dhaba" }));
    expect(html).toMatch(/data-composed=/);
    expect(composer.calls).toHaveLength(1);
    // coverage guarantee: empty composition still renders every planned item
    expect(html).toContain("data-item-id=");
  });

  it("passes findings as a re-compose note on iteration >0", async () => {
    const composer = fakeComposer();
    const painter = new CompositionPainter({
      composer,
      vocabularies: builtinVocabularies(),
      browser: fakeMeasure,
    });
    const req = makeRequest({ vocabulary: "dhaba" });
    const finding: QaFinding = {
      kind: "photo-band-overflow",
      source: "vision",
      severity: "major",
      tag: "layout",
      message: "photo band overflows",
      hardGate: false,
      deterministicallyFixable: false,
    };
    await painter.paint({ ...req, findings: [finding] });
    expect(JSON.stringify(composer.calls[0])).toContain("photo band overflows");
  });

  it("throws PaintError when the theme names an unregistered vocabulary", async () => {
    const composer = fakeComposer();
    const painter = new CompositionPainter({
      composer,
      vocabularies: builtinVocabularies(),
      browser: fakeMeasure,
    });
    await expect(painter.paint(makeRequest({ vocabulary: "no-such-vocab" }))).rejects.toMatchObject(
      {
        code: "PAINT",
      },
    );
  });
});

describe("AutoPainter", () => {
  const probe = (): Painter & { hits: number } => {
    const p = {
      hits: 0,
      paint: async () => {
        p.hits += 1;
        return "<div></div>";
      },
    };
    return p;
  };

  it("auto mode: vocabulary theme → composition; plain theme → free", async () => {
    const free = probe();
    const composition = probe();
    const auto = new AutoPainter({
      free,
      composition,
      vocabularies: builtinVocabularies(),
      mode: "auto",
    });
    await auto.paint(makeRequest({ vocabulary: "dhaba" }));
    await auto.paint(makeRequest());
    expect(composition.hits).toBe(1);
    expect(free.hits).toBe(1);
  });

  it("free mode forces the free painter even for vocabulary themes", async () => {
    const free = probe();
    const composition = probe();
    const auto = new AutoPainter({
      free,
      composition,
      vocabularies: builtinVocabularies(),
      mode: "free",
    });
    await auto.paint(makeRequest({ vocabulary: "dhaba" }));
    expect(free.hits).toBe(1);
    expect(composition.hits).toBe(0);
  });

  it("auto mode RESCUES a composition failure with free paint (board still ships)", async () => {
    const free = probe();
    const failing: Painter = {
      paint: async () => {
        throw new Error("composer unavailable");
      },
    };
    const auto = new AutoPainter({
      free,
      composition: failing,
      vocabularies: builtinVocabularies(),
      mode: "auto",
    });
    const html = await auto.paint(makeRequest({ vocabulary: "dhaba" }));
    expect(html).toBe("<div></div>");
    expect(free.hits).toBe(1);
  });

  it("forced composition mode does NOT rescue — the error surfaces", async () => {
    const free = probe();
    const failing: Painter = {
      paint: async () => {
        throw new Error("composer unavailable");
      },
    };
    const auto = new AutoPainter({
      free,
      composition: failing,
      vocabularies: builtinVocabularies(),
      mode: "composition",
    });
    await expect(auto.paint(makeRequest({ vocabulary: "dhaba" }))).rejects.toThrow(
      "composer unavailable",
    );
    expect(free.hits).toBe(0);
  });
});
