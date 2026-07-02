import { describe, expect, it } from "vitest";

import { RenderError, UnsupportedConstraintError } from "../domain/errors";
import { createFakeEngine } from "../testing/fakes/index";
import {
  cleanObservation,
  contrastFailObservation,
  deadSpaceObservation,
} from "../testing/fakes/browser";
import { fixtures } from "../testing/fixtures/index";

describe("createEngine — end-to-end pipeline (fakes)", () => {
  it("produces a passing screen + poster + report on a clean render", async () => {
    const engine = createFakeEngine({ observations: [cleanObservation()] });
    const out = await engine.generate(fixtures.input);

    expect(out.screens).toHaveLength(1);
    expect(out.posters).toHaveLength(1);
    expect(out.qaReport.screens).toHaveLength(1);
    expect(out.qaReport.passedAll).toBe(true);

    const report = out.qaReport.screens[0]!;
    expect(report.passed).toBe(true);
    expect(report.flagged).toBe(false);
    expect(out.qaReport.generatedAt).toBe("2026-06-22T00:00:00.000Z");

    // The frozen screen is self-contained and carries the data contract.
    const screen = out.screens[0]!;
    expect(screen.html).toContain("<!doctype html>");
    expect(screen.html).toContain('data-item-id="p-margherita"');
    expect(screen.itemIds).toEqual(
      expect.arrayContaining(["p-margherita", "s-garlic-bread", "c-curry"]),
    );
    expect(out.posters[0]!.pngBase64.length).toBeGreaterThan(0);
  });

  it("plan() resolves the thin plan without rendering (enables resumable, board-by-board runs)", async () => {
    const engine = createFakeEngine({ observations: [cleanObservation()] });
    const plan = await engine.plan(fixtures.input);
    expect(plan.screens.length).toBeGreaterThan(0);
    expect(plan.screens[0]!.sections.length).toBeGreaterThan(0);
  });

  it("acceptance #1: rebalances dead space via re-paint within budget", async () => {
    // Dead space on the first render; the re-paint converges on the second.
    const engine = createFakeEngine({ observations: [deadSpaceObservation(), cleanObservation()] });
    const out = await engine.generate(fixtures.input);

    const report = out.qaReport.screens[0]!;
    expect(report.passed).toBe(true);
    expect(report.routeHistory[0]).toBe("paint");
    expect(report.routeHistory).toContain("freeze");
    expect(report.iterations).toBeGreaterThanOrEqual(2);
  });

  it("acceptance #2: catches a WCAG contrast hard gate and fixes it via deterministic repair", async () => {
    const engine = createFakeEngine({
      observations: [contrastFailObservation(), cleanObservation()],
    });
    const out = await engine.generate(fixtures.input);

    const report = out.qaReport.screens[0]!;
    expect(report.passed).toBe(true);
    // The mechanical contrast fix routes to repair, never the painter (§5.6/D13).
    expect(report.routeHistory[0]).toBe("repair");
    // The frozen artifact carries the scoped contrast override the repair injected.
    expect(out.screens[0]!.html).toContain('data-repair="contrast"');
  });

  it("acceptance #3: matrix + variant-rows render correctly from the plan", async () => {
    const engine = createFakeEngine({ observations: [cleanObservation()] });
    const out = await engine.generate(fixtures.input);
    const html = out.screens[0]!.html;

    // matrix: a price cell per size for each pizza (3 sizes each)
    const margheritaPrices = ["$8.99", "$11.99", "$13.99"];
    for (const p of margheritaPrices) expect(html).toContain(p);
    // variant-rows: each variant label present and bound
    for (const label of ["Veg", "Paneer", "Chicken"]) expect(html).toContain(label);
    expect(out.qaReport.screens[0]!.passed).toBe(true);
    // No representation/binding findings survived to the report.
    expect(
      out.qaReport.screens[0]!.findings.filter(
        (f) => f.severity === "major" || f.severity === "critical",
      ),
    ).toHaveLength(0);
  });

  it("ships the best-scoring screen flagged when the critic never lets it converge (D12)", async () => {
    // The browser is clean, but the critic keeps returning a blocking finding forever.
    const engine = createFakeEngine({
      observations: [cleanObservation()],
      critiques: [
        {
          // Enough failed rubric dimensions to keep the screen below the pass threshold forever
          // (a single vision nit is graded by the rubric and would not block — D-scoring).
          findings: ["balance", "hierarchy", "representation-clarity"].map((dimension) => ({
            dimension,
            severity: "major" as const,
            tag: "layout" as const,
            region: "whole",
            message: "still off",
          })),
        },
      ],
    });
    const out = await engine.generate(fixtures.input);

    const report = out.qaReport.screens[0]!;
    expect(report.passed).toBe(false);
    expect(report.flagged).toBe(true);
    expect(report.routeHistory.at(-1)).toBe("freeze");
    // Budget bounded the loop (default maxIterations 3), and we still got an artifact.
    expect(out.screens).toHaveLength(1);
    expect(out.qaReport.passedAll).toBe(false);
  });

  it("renders every board in a caller-authored multi-screen plan", async () => {
    const plan = {
      screens: [
        {
          id: "screen-1",
          sections: [
            { title: "PIZZAS", representation: "matrix", items: ["p-margherita", "p-pepperoni"] },
          ],
        },
        {
          id: "screen-2",
          sections: [
            { title: "SIDES", representation: "list", items: ["s-garlic-bread"] },
            { title: "CURRIES", representation: "variant-rows", items: ["c-curry"] },
          ],
        },
      ],
    };
    const engine = createFakeEngine({ observations: [cleanObservation()] });
    const out = await engine.generate({
      ...fixtures.input,
      plan,
      constraints: { aspect: "16:9", screens: 2 },
    });

    expect(out.screens.map((s) => s.id)).toEqual(["screen-1", "screen-2"]);
    expect(out.posters).toHaveLength(2);
    expect(out.qaReport.screens).toHaveLength(2);
    expect(out.qaReport.passedAll).toBe(true);
    // Each board carries only its own items (the allocation the caller authored).
    expect(out.screens[0]!.itemIds).toEqual(["p-margherita", "p-pepperoni"]);
    expect(out.screens[1]!.itemIds).toEqual(expect.arrayContaining(["s-garlic-bread", "c-curry"]));
    expect(out.screens[0]!.html).toContain('data-item-id="p-margherita"');
    expect(out.screens[0]!.html).not.toContain('data-item-id="c-curry"');
  });

  it("inlines remote item photos and renders an offline-safe gallery-fade carousel", async () => {
    // Items carry REMOTE photo URLs; the fetchImages node + FakeImageFetcher must resolve them
    // to data-URIs before paint, and the carousel must ship with no surviving http(s) src.
    const input = {
      items: [
        {
          id: "a",
          name: "Veg Noodles",
          category: "indo",
          available: true,
          price: 13.99,
          images: ["https://cdn.example.com/a.jpg"],
        },
        {
          id: "b",
          name: "Chicken Noodles",
          category: "indo",
          available: true,
          price: 15.49,
          images: ["https://cdn.example.com/b.jpg"],
        },
      ],
      brief: { presetId: "botanical" },
      constraints: { aspect: "16:9", screens: 1 },
      plan: {
        screens: [
          {
            id: "screen-1",
            imageSlot: { categoryId: "indo", items: ["a", "b"] },
            sections: [{ title: "INDO-CHINESE", representation: "grid", items: ["a", "b"] }],
          },
        ],
      },
    };
    const engine = createFakeEngine({ observations: [cleanObservation()] });
    const out = await engine.generate(input);
    const html = out.screens[0]!.html;

    expect(out.qaReport.screens[0]!.passed).toBe(true);
    expect(html).toContain('data-motion="gallery-fade"');
    expect(html).toContain("data-motion-runtime");
    // Remote URLs were inlined: a data-URI ships, and no http(s) src survives (offline-safe).
    expect(html).toContain('src="data:image');
    expect(html).not.toMatch(/src="https?:\/\//);
  });

  it("rejects a screens count that disagrees with the plan", async () => {
    const engine = createFakeEngine();
    // fixtures.input.plan has 1 screen; asking for 2 is a mismatch.
    await expect(
      engine.generate({ ...fixtures.input, constraints: { aspect: "16:9", screens: 2 } }),
    ).rejects.toBeInstanceOf(UnsupportedConstraintError);
  });

  it("validates input at the boundary", async () => {
    const engine = createFakeEngine();
    await expect(engine.generate({ items: [] })).rejects.toThrow(/Invalid generate input/);
  });

  it("renders and inlines a brand logo header when brand content is provided", async () => {
    const logo = "data:image/png;base64,AAAABBBBCCCC";
    const engine = createFakeEngine({ observations: [cleanObservation()] });
    const out = await engine.generate({
      ...fixtures.input,
      brand: { logo: { src: logo, alt: "Acme" }, name: "Acme Diner", tagline: "Fresh daily" },
    });
    const screen = out.screens[0]!;
    expect(screen.html).toContain("data-brand-logo");
    expect(screen.html).toContain(logo); // packager injected the resolved data-URI
    expect(screen.html).toContain("Acme Diner");
    expect(out.qaReport.screens[0]!.passed).toBe(true); // brand-binding check passes
  });

  it("derives a portrait render + frozen geometry from constraints.aspect (D19)", async () => {
    // Default qa.viewport is landscape 1920×1080; aspect 9:16 must re-orient it to portrait for
    // the render, the QA precondition, and the frozen meta/poster — for every caller, not just try.ts.
    const engine = createFakeEngine({
      observations: [cleanObservation({ width: 1080, height: 1920 })],
    });
    const out = await engine.generate({
      ...fixtures.input,
      constraints: { aspect: "9:16", screens: 1 },
    });

    const screen = out.screens[0]!;
    expect(screen.meta.aspect).toBe("9:16");
    expect(screen.meta.width).toBe(1080);
    expect(screen.meta.height).toBe(1920);
    expect(out.posters[0]!.width).toBe(1080);
    expect(out.posters[0]!.height).toBe(1920);
    expect(out.qaReport.screens[0]!.passed).toBe(true);
  });

  it("fails the viewport hard gate when the render disagrees with the aspect-derived target (D19)", async () => {
    // aspect 9:16 derives a 1080×1920 target, but the (fake) browser renders landscape 1920×1080 —
    // proving the derived viewport, not the raw qa.viewport, reaches the checkViewport precondition.
    const engine = createFakeEngine({ observations: [cleanObservation()] });
    await expect(
      engine.generate({ ...fixtures.input, constraints: { aspect: "9:16", screens: 1 } }),
    ).rejects.toBeInstanceOf(RenderError);
  });
});
