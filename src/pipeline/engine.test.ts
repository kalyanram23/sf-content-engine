import { describe, expect, it } from "vitest";

import type { CritiqueResponse, PlanLayout } from "../domain/contracts";
import { UnsupportedConstraintError } from "../domain/errors";
import type { CanonicalItem } from "../domain/types";
import { expandLayoutToPlan } from "../planning/coverage";
import type { Painter, PaintRequest } from "../ports/painter";
import type { VisionCritic } from "../ports/vision-critic";
import {
  createFakeEngine,
  FakeImageFetcher,
  FakePainter,
  ScriptedVisionCritic,
} from "../testing/fakes/index";
import {
  cleanObservation,
  clippedItemObservation,
  contrastFailObservation,
  deadSpaceObservation,
  overflowClampObservation,
  overflowObservation,
} from "../testing/fakes/browser";
import { fixtures } from "../testing/fixtures/index";
import { PLACEHOLDER_IMAGE_BASE64 } from "../util/placeholder-image";

/** A painter that records every request while delegating to the real FakePainter. */
class SpyPainter implements Painter {
  readonly requests: PaintRequest[] = [];
  private readonly inner = new FakePainter();

  paint(request: PaintRequest): Promise<string> {
    this.requests.push(request);
    return this.inner.paint(request);
  }
}

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

  it("shrinks an overflowing board to fit deterministically, without burning a re-paint (D31)", async () => {
    // Iteration 1 renders content past the bottom edge (a "cut off at the bottom" board the vision
    // judge rejects). The overflow is a small, legible shrink away from fitting, so it routes to the
    // deterministic shrink-to-fit repair — NOT the painter — and converges on the re-render.
    const spy = new SpyPainter();
    const engine = createFakeEngine({
      observations: [overflowObservation(), cleanObservation()],
      ports: { painter: spy },
    });
    const out = await engine.generate(fixtures.input);

    const report = out.qaReport.screens[0]!;
    expect(report.passed).toBe(true);
    // The mechanical shrink routes to repair, never the painter (§5.6/D13/D31).
    expect(report.routeHistory[0]).toBe("repair");
    // The frozen artifact carries the injected shrink-to-fit style (it ships in the packaged HTML).
    expect(out.screens[0]!.html).toContain('data-repair="fit"');
    expect(out.screens[0]!.html).toContain("transform:scale(");
    // The painter ran exactly ONCE — the fix came from code, not a re-paint iteration.
    expect(spy.requests).toHaveLength(1);
  });

  it("escalates an un-shrinkable overflow (would go illegible) to a re-paint (D31)", async () => {
    // The content is 2× too tall AND carries tiny item text: a fit shrink would push it below the
    // legibility floor, so the deterministic path DECLINES and the finding routes to the painter.
    const spy = new SpyPainter();
    const engine = createFakeEngine({
      observations: [overflowClampObservation(), cleanObservation()],
      ports: { painter: spy },
    });
    const out = await engine.generate(fixtures.input);

    const report = out.qaReport.screens[0]!;
    expect(report.passed).toBe(true);
    // A shrink that trades overflow for illegible type is a net loss → re-paint, not repair.
    expect(report.routeHistory[0]).toBe("paint");
    // No shrink style was injected, and the painter was re-invoked to re-lay-out the board.
    expect(out.screens[0]!.html).not.toContain('data-repair="fit"');
    expect(spy.requests.length).toBeGreaterThanOrEqual(2);
  });

  it("re-paints a silently-clipped item that scored clean on scroll-overflow (QA blindspot fix)", async () => {
    // Iteration 1: the page does NOT scroll (checkOverflow silent), but a section's last item is cut
    // off at the bottom edge inside an overflow-hidden container — only its layout rect reveals it.
    // The item-cutoff finding is a major, NOT-deterministically-fixable content defect, so it routes
    // to a re-paint (never a shrink repair — a scale can't un-clip a clipped container). Iteration 2
    // is clean and converges.
    const spy = new SpyPainter();
    const engine = createFakeEngine({
      observations: [clippedItemObservation(), cleanObservation()],
      ports: { painter: spy },
    });
    const out = await engine.generate(fixtures.input);

    const report = out.qaReport.screens[0]!;
    expect(report.passed).toBe(true);
    // A silent clip re-paints (content, not a mechanical fix) — never a shrink repair.
    expect(report.routeHistory[0]).toBe("paint");
    expect(out.screens[0]!.html).not.toContain('data-repair="fit"');
    // The painter ran again to re-lay-out the board so nothing clips.
    expect(spy.requests.length).toBeGreaterThanOrEqual(2);
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

  it("acceptance: a computed-matrix board renders a valid comparison table and converges (§ Phase 1–4)", async () => {
    // A Biryani×Pulav menu whose pairing is computed at plan time (buildMatrix), rendered by the
    // FakePainter as a true row×column table, and validated by the new matrix-structure check.
    const menu: CanonicalItem[] = [
      { id: "b-chicken", name: "Chicken Biryani", category: "Biryani", available: true, price: 12 },
      { id: "b-paneer", name: "Paneer Biryani", category: "Biryani", available: true, price: 11 },
      { id: "b-egg", name: "Egg Biryani", category: "Biryani", available: true, price: 10 },
      { id: "p-chicken", name: "Chicken Pulav", category: "Pulav", available: true, price: 13 },
    ];
    const layout: PlanLayout = {
      blocks: [
        {
          title: "Biryani & Pulav",
          categories: ["Biryani", "Pulav"],
          representation: "matrix",
          layoutHint: "price table: rows = base dish, columns = Biryani | Pulav",
        },
      ],
    };
    const plan = expandLayoutToPlan(layout, menu, 1);
    const section = plan.screens[0]!.sections.find((s) => s.matrix !== undefined);
    expect(section?.matrix?.columns).toEqual(["Biryani", "Pulav"]);

    const engine = createFakeEngine({ observations: [cleanObservation()] });
    const out = await engine.generate({
      items: menu,
      brief: { presetId: "botanical" },
      constraints: { aspect: "16:9", screens: plan.screens.length },
      plan,
    });

    const report = out.qaReport.screens[0]!;
    expect(report.passed).toBe(true);
    // The FakePainter's table honoured the matrix skeleton → no matrix-structure findings survived.
    expect(report.findings.filter((f) => f.kind === "matrix-structure")).toHaveLength(0);
    // The frozen artifact carries the true comparison-table DOM (not stacked cards).
    const html = out.screens[0]!.html;
    expect(html).toContain("data-matrix");
    expect(html).toContain('data-matrix-cell="Biryani"');
    expect(html).toContain('data-matrix-cell="Pulav"');
    expect(html).toContain("data-matrix-row=");
    // Chicken pairs across both columns; the em-dash cells (Paneer/Egg have no Pulav) carry no price.
    expect(html).toContain('data-item-id="p-chicken"');
    expect(html).toContain("—");
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

  it("skips the paid vision critique on a gate-blocked iteration, runs it once the render is clean (D27)", async () => {
    // Iteration 1 renders dead space → a deterministic density major that GATE-BLOCKS: the critique
    // cannot change the route, so it is skipped. Iteration 2 is clean and IS critiqued → one call.
    const critic = new ScriptedVisionCritic([{ findings: [] }]);
    const engine = createFakeEngine({
      observations: [deadSpaceObservation(), cleanObservation()],
      ports: { visionCritic: critic },
    });
    const out = await engine.generate(fixtures.input);

    const report = out.qaReport.screens[0]!;
    expect(report.passed).toBe(true);
    expect(report.routeHistory[0]).toBe("paint");
    // Only the clean iteration was critiqued; the blocked iteration spent nothing on the critic.
    expect(critic.callCount.value).toBe(1);
  });

  it("restores the critique on a gate-blocked iteration when skipVisionWhenBlocking is false (D27)", async () => {
    // Flag off → legacy hard-gate-only skip: the (non-hard-gate) density-major iteration is still
    // critiqued, so both the blocked iteration 1 and the clean iteration 2 call the critic.
    const critic = new ScriptedVisionCritic([{ findings: [] }]);
    const engine = createFakeEngine({
      observations: [deadSpaceObservation(), cleanObservation()],
      ports: { visionCritic: critic },
      config: { qa: { skipVisionWhenBlocking: false } },
    });
    const out = await engine.generate(fixtures.input);

    expect(out.qaReport.screens[0]!.passed).toBe(true);
    expect(critic.callCount.value).toBe(2);
  });

  it("critiques the shipped candidate once at freeze when the loop never got to (freeze-path critique, Fix 1)", async () => {
    // Every render shows dead space → a deterministic density MAJOR that gate-blocks, so the paid
    // vision pass is SKIPPED on every iteration (D27). The board never converges and freezes flagged
    // with a candidate carrying ZERO vision findings. Freeze must run ONE make-good critique and
    // persist its findings + an honest (no longer vacuous) rubric on the report.
    const critic = new ScriptedVisionCritic([
      {
        findings: [
          {
            dimension: "balance",
            severity: "major" as const,
            tag: "layout" as const,
            region: "whole",
            message: "large dead space at the bottom",
          },
        ],
      },
    ]);
    const engine = createFakeEngine({
      observations: [deadSpaceObservation()], // clamped → dead space on every render
      ports: { visionCritic: critic },
    });
    const out = await engine.generate(fixtures.input);

    const report = out.qaReport.screens[0]!;
    // The loop skipped vision on every blocked iteration; the ONLY critic call is the freeze make-good.
    expect(critic.callCount.value).toBe(1);
    // The shipped board stays flagged — `passed` did not flip — but now carries the vision finding.
    expect(report.passed).toBe(false);
    expect(report.flagged).toBe(true);
    const vision = report.findings.filter((f) => f.source === "vision");
    expect(vision).toHaveLength(1);
    expect(vision[0]!.kind).toBe("balance");
    // The rubric is now honest: the failed balance dimension drops it below the vacuous 1.00.
    expect(report.rubricScore).toBeLessThan(1);
  });

  it("does NOT re-critique at freeze a shipped candidate already vision-critiqued (Fix 1)", async () => {
    // Clean render every iteration → vision runs each time; the critic keeps it below threshold so it
    // never passes and freezes flagged — but the shipped candidate WAS critiqued, so freeze adds no call.
    const critic = new ScriptedVisionCritic([
      {
        findings: ["balance", "hierarchy", "representation-clarity"].map((dimension) => ({
          dimension,
          severity: "major" as const,
          tag: "layout" as const,
          region: "whole",
          message: "still off",
        })),
      },
    ]);
    const engine = createFakeEngine({
      observations: [cleanObservation()],
      ports: { visionCritic: critic },
    });
    const out = await engine.generate(fixtures.input);

    const report = out.qaReport.screens[0]!;
    expect(report.passed).toBe(false);
    expect(report.flagged).toBe(true);
    // Vision ran once per iteration (default budget 3); freeze added NO extra call.
    expect(critic.callCount.value).toBe(3);
  });

  it("degrades gracefully when the freeze-path critique throws — report identical to today (Fix 1)", async () => {
    // Same un-critiqued-shipped setup, but the critic throws. Freeze catches it and ships exactly
    // today's report: deterministic findings only, the pre-critique (vacuous) rubric, still flagged.
    class ThrowingCritic implements VisionCritic {
      readonly callCount = { value: 0 };
      critique(): Promise<CritiqueResponse> {
        this.callCount.value += 1;
        return Promise.reject(new Error("critic unavailable"));
      }
    }
    const critic = new ThrowingCritic();
    const engine = createFakeEngine({
      observations: [deadSpaceObservation()],
      ports: { visionCritic: critic },
    });
    const out = await engine.generate(fixtures.input);

    const report = out.qaReport.screens[0]!;
    // It tried exactly once at freeze, then shipped without the critique.
    expect(critic.callCount.value).toBe(1);
    expect(report.passed).toBe(false);
    expect(report.flagged).toBe(true);
    // No vision finding was merged; the rubric stays the pre-critique 1.00.
    expect(report.findings.some((f) => f.source === "vision")).toBe(false);
    expect(report.rubricScore).toBe(1);
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

  it("isolates a terminally-failing board: the fleet still ships, the failed board carries the error (D28)", async () => {
    // A 3-board plan where board 2's painter throws a terminal PaintError (retries already spent).
    // Boards 1 + 3 must still render and ship; board 2 gets an error report and NO screen/poster.
    const plan = {
      screens: [
        {
          id: "screen-1",
          sections: [{ title: "PIZZAS", representation: "matrix", items: ["p-margherita"] }],
        },
        {
          id: "screen-2",
          sections: [{ title: "SIDES", representation: "list", items: ["s-garlic-bread"] }],
        },
        {
          id: "screen-3",
          sections: [{ title: "CURRIES", representation: "variant-rows", items: ["c-curry"] }],
        },
      ],
    };
    const engine = createFakeEngine({
      observations: [cleanObservation()],
      ports: { painter: new FakePainter({ failScreenIds: ["screen-2"] }) },
    });
    const out = await engine.generate({
      ...fixtures.input,
      plan,
      constraints: { aspect: "16:9", screens: 3 },
    });

    // The two healthy boards shipped, in plan order; the failed board emitted no artifact.
    expect(out.screens.map((s) => s.id)).toEqual(["screen-1", "screen-3"]);
    expect(out.posters).toHaveLength(2);

    // qaReport.screens is the authoritative per-board record — all three boards, keyed by screenId.
    expect(out.qaReport.screens.map((r) => r.screenId)).toEqual([
      "screen-1",
      "screen-2",
      "screen-3",
    ]);
    expect(out.qaReport.passedAll).toBe(false);

    const failed = out.qaReport.screens.find((r) => r.screenId === "screen-2")!;
    expect(failed.error).toEqual({ code: "PAINT", message: expect.stringContaining("screen-2") });
    expect(failed.passed).toBe(false);
    expect(failed.flagged).toBe(true);
    expect(failed.iterations).toBe(0);
    expect(failed.findings).toEqual([]);
    expect(failed.routeHistory).toEqual([]);

    // The healthy boards passed and carry no error.
    for (const id of ["screen-1", "screen-3"]) {
      const report = out.qaReport.screens.find((r) => r.screenId === id)!;
      expect(report.passed).toBe(true);
      expect(report.error).toBeUndefined();
    }
  });

  it("still THROWS a run-level failure (theme-not-found) instead of containing it (D28)", async () => {
    // Theme resolution is per-board, but the preset is the same for the whole run — a missing theme
    // is a run-level failure that must abort generate(), NOT degrade to a per-board error report.
    const engine = createFakeEngine({ observations: [cleanObservation()] });
    await expect(
      engine.generate({ ...fixtures.input, brief: { presetId: "no-such-theme" } }),
    ).rejects.toMatchObject({ code: "THEME_NOT_FOUND" });
  });

  it("persists the human-meaningful rubricScore (0..1) + penalty on a passing board (D28)", async () => {
    const engine = createFakeEngine({ observations: [cleanObservation()] });
    const out = await engine.generate(fixtures.input);

    const report = out.qaReport.screens[0]!;
    expect(report.passed).toBe(true);
    // rubricScore is the readable fraction (unlike the internal comparator `score`, which encodes a
    // giant lexicographic total). A clean pass clears the rubric threshold.
    expect(report.rubricScore).toBeGreaterThanOrEqual(0);
    expect(report.rubricScore).toBeLessThanOrEqual(1);
    expect(report.rubricScore).toBeGreaterThan(0);
    expect(report.penalty).toBeGreaterThanOrEqual(0);
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

  it("drops a failed photo fetch everywhere: no fake photo claim, no placeholder slide (photo truth)", async () => {
    const realPhoto = "data:image/png;base64,REALPHOTO0000";
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
          images: ["https://cdn.example.com/b.jpg"], // this fetch FAILS
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
    const spy = new SpyPainter();
    const engine = createFakeEngine({
      observations: [cleanObservation()],
      ports: {
        painter: spy,
        imageFetcher: new FakeImageFetcher({
          failUrls: ["https://cdn.example.com/b.jpg"],
          dataUri: realPhoto,
        }),
      },
    });
    const out = await engine.generate(input);

    // The paint request tells the truth: b has NO photo, and the imageSlot excludes it.
    const request = spy.requests[0]!;
    const itemB = request.items.find((i) => i.id === "b")!;
    expect(itemB.images ?? []).toHaveLength(0);
    expect(request.planScreen.imageSlot?.items).toEqual(["a"]);
    // b still renders as a card (coverage untouched) — only its photo claim is gone.
    const html = out.screens[0]!.html;
    expect(html).toContain('data-item-id="b"');
    // The surviving photo is the real data-URI; the 1×1 placeholder never ships as a slide.
    expect(html).toContain(realPhoto);
    expect(html).not.toContain(PLACEHOLDER_IMAGE_BASE64);
    expect(out.qaReport.screens[0]!.passed).toBe(true);
  });

  it("renders a per-category image slot on every section of a comfortable board (photos + icon)", async () => {
    // A comfortable, non-matrix board: the photo category gets a real photo panel, the photo-less
    // category a deliberate food-icon panel — each tagged data-image-slot="<category>" so the
    // category-images requirement is deterministically checkable in the shipped HTML.
    const input = {
      items: [
        {
          id: "a",
          name: "Chicken Mandi",
          category: "MANDI",
          available: true,
          price: 12,
          images: ["data:image/png;base64,REALMANDI0000"],
        },
        { id: "b", name: "Kunafa", category: "DESSERTS", available: true, price: 8 },
      ],
      brief: { presetId: "botanical" },
      constraints: { aspect: "16:9", screens: 1 } as const,
      plan: {
        screens: [
          {
            id: "screen-1",
            densityTier: "comfortable" as const,
            sections: [
              {
                title: "MANDI",
                representation: "grid" as const,
                items: ["a"],
                imageSlot: { kind: "photos" as const, items: ["a"] },
              },
              {
                title: "DESSERTS",
                representation: "grid" as const,
                items: ["b"],
                imageSlot: { kind: "icon" as const, items: [] },
              },
            ],
          },
        ],
      },
    };
    const engine = createFakeEngine({ observations: [cleanObservation()] });
    const out = await engine.generate(input);
    const html = out.screens[0]!.html;

    expect(out.qaReport.screens[0]!.passed).toBe(true);
    // Both categories carry a data-image-slot anchor.
    expect(html).toContain('data-image-slot="MANDI"');
    expect(html).toContain('data-image-slot="DESSERTS"');
    // The photo category renders a real photo (inlined data-URI); the icon category an inline SVG.
    expect(html).toContain("REALMANDI0000");
    expect(html).toContain("<svg");
  });

  it("passes a plan-forced dense over-budget board with a warning-level density note (D25/D26)", async () => {
    // A 34-item single category is the caller's data problem: exact mode keeps it on ONE board,
    // the painter gets the two-column over-budget directive, and a 96% fill grades as a MINOR
    // plan-forced note — the board PASSES instead of burning the budget on an impossible major.
    const menu: CanonicalItem[] = Array.from({ length: 34 }, (_, i) => ({
      id: `c${i}`,
      name: `Curry ${i}`,
      category: "Curries",
      available: true,
      price: 9 + i,
    }));
    const layout: PlanLayout = {
      blocks: [
        { title: "Curries", categories: ["Curries"], representation: "list", layoutHint: "" },
      ],
    };
    const warnings: string[] = [];
    const plan = expandLayoutToPlan(layout, menu, 1, {
      screensMode: "exact",
      logger: { warn: (m) => warnings.push(m) },
    });
    expect(plan.screens).toHaveLength(1);
    expect(warnings.some((w) => /dense/i.test(w))).toBe(true);

    const spy = new SpyPainter();
    const engine = createFakeEngine({
      observations: [cleanObservation({ fillRatio: 0.96 })],
      ports: { painter: spy },
      // Relax the pre-render capacity caps like coverage-mode callers do (try.ts) — the point
      // here is the density grading, not re-plan escalation.
      config: { qa: { capacities: { matrix: 60, "variant-rows": 48, grid: 48, list: 80 } } },
    });
    const out = await engine.generate({
      items: menu,
      brief: { presetId: "botanical" },
      constraints: { aspect: "16:9", screens: 1 },
      plan,
    });

    // The painter (and critic) were actively directed to the two-column over-budget layout.
    expect(spy.requests[0]!.sizeDirective).toMatch(/over-budget/i);
    expect(spy.requests[0]!.sizeDirective).toMatch(/TWO balanced narrow columns/i);

    const report = out.qaReport.screens[0]!;
    expect(report.passed).toBe(true);
    expect(report.flagged).toBe(false);
    const density = report.findings.find((f) => f.kind === "density");
    expect(density).toBeDefined();
    expect(density?.severity).toBe("minor");
    expect(density?.data?.["planForced"]).toBe(true);
    // One clean paint — the loop did not burn iterations fighting the plan's own density.
    expect(report.iterations).toBe(1);
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

  it("fails the viewport hard gate when the render disagrees with the aspect-derived target (D19/D28)", async () => {
    // aspect 9:16 derives a 1080×1920 target, but the (fake) browser renders landscape 1920×1080.
    // The viewport RenderError is now CONTAINED per-board (bulkhead, D28): the board ships no artifact
    // and carries a RENDER error report whose message names the derived target (1080x1920), proving
    // the aspect-derived viewport — not the raw qa.viewport — reached the checkViewport precondition.
    const engine = createFakeEngine({ observations: [cleanObservation()] });
    const out = await engine.generate({
      ...fixtures.input,
      constraints: { aspect: "9:16", screens: 1 },
    });

    expect(out.screens).toHaveLength(0);
    expect(out.posters).toHaveLength(0);
    expect(out.qaReport.passedAll).toBe(false);
    const report = out.qaReport.screens[0]!;
    expect(report.error?.code).toBe("RENDER");
    expect(report.error?.message).toContain("1080x1920");
  });
});
