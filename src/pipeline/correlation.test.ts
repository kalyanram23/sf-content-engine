import { describe, expect, it } from "vitest";

import type { GenerateInput, ThinPlan } from "../domain/types";
import type { RequestCorrelation } from "../ports/correlation";
import type { Painter, PaintRequest } from "../ports/painter";
import type { Planner } from "../ports/planner";
import { createFakeEngine } from "../testing/fakes/index";
import { FakePainter } from "../testing/fakes/painter";

/** Records the correlation each planner call receives, returning a fixed plan. */
class CapturingPlanner implements Planner {
  readonly seen: (RequestCorrelation | undefined)[] = [];
  constructor(private readonly fixed: ThinPlan) {}
  plan(_input: GenerateInput, correlation?: RequestCorrelation): Promise<ThinPlan> {
    this.seen.push(correlation);
    return Promise.resolve(this.fixed);
  }
}

/** Records the correlation each paint call receives, delegating to the real fake for valid HTML. */
class CapturingPainter implements Painter {
  readonly seen: (RequestCorrelation | undefined)[] = [];
  private readonly inner = new FakePainter();
  paint(request: PaintRequest): Promise<string> {
    this.seen.push(request.correlation);
    return this.inner.paint(request);
  }
}

const twoBoardPlan: ThinPlan = {
  screens: [
    { id: "screen-1", sections: [{ title: "Hot", representation: "list", items: ["i1"] }] },
    { id: "screen-2", sections: [{ title: "Cold", representation: "list", items: ["i2"] }] },
  ],
};

function inputWith(brief: GenerateInput["brief"]): GenerateInput {
  return {
    items: [
      { id: "i1", name: "Tea", price: 2, available: true },
      { id: "i2", name: "Coffee", price: 3, available: true },
    ],
    brief,
    // No `plan` on the input, so the engine asks the Planner port (exercises planner correlation).
    constraints: { aspect: "16:9", screens: 2, locale: "en-US", currency: "USD" },
  } as GenerateInput;
}

describe("observability correlation threading", () => {
  it("passes a run-level correlation (runId + restaurant, no board) to the planner", async () => {
    const planner = new CapturingPlanner(twoBoardPlan);
    const engine = createFakeEngine({ ports: { planner } });

    await engine.generate(inputWith({ presetId: "botanical", restaurant: "Chai Point" }));

    // FakeIdGenerator is a deterministic counter; the first `run` id minted is the run id.
    expect(planner.seen).toEqual([{ runId: "run-1", restaurant: "Chai Point" }]);
  });

  it("passes a per-board correlation (shared runId, distinct screenId) to the painter", async () => {
    const planner = new CapturingPlanner(twoBoardPlan);
    const painter = new CapturingPainter();
    const engine = createFakeEngine({ ports: { planner, painter } });

    await engine.generate(inputWith({ presetId: "botanical", restaurant: "Chai Point" }));

    expect(painter.seen).toEqual([
      { runId: "run-1", restaurant: "Chai Point", screenId: "screen-1", iteration: 0 },
      { runId: "run-1", restaurant: "Chai Point", screenId: "screen-2", iteration: 0 },
    ]);
  });

  it("omits restaurant from the correlation when the brief has none", async () => {
    const planner = new CapturingPlanner(twoBoardPlan);
    const engine = createFakeEngine({ ports: { planner } });

    await engine.generate(inputWith({ presetId: "botanical" }));

    expect(planner.seen).toEqual([{ runId: "run-1" }]);
  });
});
