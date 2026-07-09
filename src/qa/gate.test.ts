import { describe, expect, it } from "vitest";

import { makeFinding } from "./finding";
import { decideGate } from "./gate";

const deterministicMajor = makeFinding({
  kind: "density",
  source: "deterministic",
  severity: "major",
  tag: "layout",
  message: "dead space",
});
const deterministicMinor = makeFinding({
  kind: "x",
  source: "deterministic",
  severity: "minor",
  tag: "content",
  message: "nit",
});
const hardGate = makeFinding({
  kind: "contrast",
  source: "deterministic",
  severity: "critical",
  tag: "mechanical",
  hardGate: true,
  message: "low contrast",
});
const visionCritical = makeFinding({
  kind: "balance",
  source: "vision",
  severity: "critical",
  tag: "layout",
  message: "last row clipped at the canvas edge",
});
const visionMajor = makeFinding({
  kind: "balance",
  source: "vision",
  severity: "major",
  tag: "layout",
  message: "some dead space at the bottom",
});

describe("decideGate", () => {
  it("does not block a clean finding set", () => {
    const decision = decideGate([], "major");
    expect(decision.blocking).toBe(false);
    expect(decision.hardGateFailures).toBe(0);
  });

  it("blocks on a VISION CRITICAL finding (frontier judge — its rare criticals are real ship-blockers)", () => {
    expect(decideGate([visionCritical], "major").blocking).toBe(true);
  });

  it("does NOT block on a vision MAJOR — vision majors stay rubric-graded (variance tolerance)", () => {
    expect(decideGate([visionMajor], "major").blocking).toBe(false);
  });

  it("blocks a vision critical independent of the deterministic blockingSeverity threshold", () => {
    // Even with the deterministic threshold raised to critical, a vision critical still hard-blocks.
    expect(decideGate([visionCritical], "critical").blocking).toBe(true);
  });

  it("keeps deterministic behaviour unchanged: a deterministic major blocks at the default threshold", () => {
    expect(decideGate([deterministicMajor], "major").blocking).toBe(true);
  });

  it("keeps deterministic behaviour unchanged: raising the threshold to critical unblocks a deterministic major", () => {
    expect(decideGate([deterministicMajor], "critical").blocking).toBe(false);
  });

  it("keeps deterministic behaviour unchanged: a deterministic minor never blocks at the major threshold", () => {
    expect(decideGate([deterministicMinor], "major").blocking).toBe(false);
  });

  it("keeps the hard gate unchanged: a hard-gate finding blocks and is counted", () => {
    const decision = decideGate([hardGate], "major");
    expect(decision.blocking).toBe(true);
    expect(decision.hardGateFailures).toBe(1);
  });
});
