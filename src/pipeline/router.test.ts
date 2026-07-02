import { describe, expect, it } from "vitest";

import { defaultLoopConfig, defaultRoutingRules } from "../config/index";
import type { QaFinding } from "../domain/types";
import { makeFinding } from "../qa/finding";
import { route } from "./router";

const routing = defaultRoutingRules();
const loop = defaultLoopConfig(); // maxIterations 3

const contrast: QaFinding = makeFinding({
  kind: "contrast",
  source: "deterministic",
  severity: "critical",
  tag: "mechanical",
  hardGate: true,
  deterministicallyFixable: true,
  region: '[data-bind="price"]',
  message: "low contrast",
});
const capacity: QaFinding = makeFinding({
  kind: "overflow-capacity",
  source: "deterministic",
  severity: "major",
  tag: "structural",
  message: "too many items",
});
const density: QaFinding = makeFinding({
  kind: "density",
  source: "deterministic",
  severity: "major",
  tag: "layout",
  message: "dead space",
});
const visionMinor: QaFinding = makeFinding({
  kind: "balance",
  source: "vision",
  severity: "minor",
  tag: "layout",
  message: "slightly off",
});

describe("route — termination (D12)", () => {
  it("freezes the instant the iteration budget is spent, even with findings", () => {
    expect(route({ findings: [density], iteration: loop.maxIterations }, routing, loop)).toBe(
      "freeze",
    );
  });

  it("freezes when there are no actionable findings", () => {
    expect(route({ findings: [], iteration: 0 }, routing, loop)).toBe("freeze");
    expect(route({ findings: [visionMinor], iteration: 0 }, routing, loop)).toBe("freeze");
  });
});

describe("route — hybrid policy (§5.6)", () => {
  it("routes a deterministically-fixable mechanical finding to repair", () => {
    expect(route({ findings: [contrast], iteration: 0 }, routing, loop)).toBe("repair");
  });

  it("routes a structural-capacity finding straight to freeze (re-paint/plan can't fix it)", () => {
    expect(route({ findings: [capacity], iteration: 0 }, routing, loop)).toBe("freeze");
  });

  it("routes a high-severity PAINTABLE finding to paint, not plan (S1)", () => {
    expect(route({ findings: [density], iteration: 0 }, routing, loop)).toBe("paint");
  });

  it("routes a major vision finding to paint", () => {
    const visionMajor = makeFinding({
      kind: "hierarchy",
      source: "vision",
      severity: "major",
      tag: "layout",
      message: "x",
    });
    expect(route({ findings: [visionMajor], iteration: 0 }, routing, loop)).toBe("paint");
  });

  it("honours priority: capacity (freeze) outranks a co-occurring contrast (repair)", () => {
    expect(route({ findings: [contrast, capacity], iteration: 0 }, routing, loop)).toBe("freeze");
  });

  it("prefers repair over paint when both could match", () => {
    expect(route({ findings: [contrast, density], iteration: 0 }, routing, loop)).toBe("repair");
  });
});
