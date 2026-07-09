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

  it("prefers repair over paint when the co-occurring finding is minor (non-blocking)", () => {
    // Repair-first (minimal-change) still wins when the other finding does NOT block the pass: a
    // MINOR nit is below `blockingSeverity` (major), so fixing the cheap mechanical finding this
    // iteration can genuinely converge the board.
    const minorNit = makeFinding({
      kind: "balance",
      source: "deterministic",
      severity: "minor",
      tag: "layout",
      message: "slightly off",
    });
    expect(route({ findings: [contrast, minorNit], iteration: 0 }, routing, loop)).toBe("repair");
  });

  it("routes a MAJOR-unfixable deterministic finding to paint even when a fixable finding co-occurs (D65)", () => {
    // The repair-loop dead-end: a board with a fixable contrast finding AND a deterministically
    // UNFIXABLE major (a broken matrix comparison table). Because `blockingSeverity` is major, the
    // matrix finding blocks the pass regardless of the contrast fix — so a token-swap merely polishes
    // a board that cannot pass, and the mechanical-fix rule would win repair every iteration while the
    // broken DOM never gets re-painted. The unfixable-structural rule (92) must outrank it → paint.
    const matrixMajor = makeFinding({
      kind: "matrix-structure",
      source: "deterministic",
      severity: "major",
      tag: "layout",
      deterministicallyFixable: false,
      message: 'Matrix row "veg" has 1 cell(s); expected 2 (one per column).',
    });
    expect(route({ findings: [contrast, matrixMajor], iteration: 0 }, routing, loop)).toBe("paint");
  });

  it("does NOT let the unfixable-structural rule swallow a plain fixable finding (still repairs)", () => {
    // With no co-occurring major-unfixable finding, a lone fixable mechanical finding still repairs.
    expect(route({ findings: [contrast], iteration: 0 }, routing, loop)).toBe("repair");
  });

  it("does NOT let the unfixable-structural rule (92) claim a MAJOR VISION finding", () => {
    // A fixable contrast finding co-occurring with a MAJOR VISION finding. If rule 92 wrongly matched
    // the vision finding it would force paint (92 > 90); because 92 is source-scoped to deterministic
    // it does NOT, so the fixable contrast still wins mechanical-fix (90) → repair. The "repair" result
    // is the proof the vision finding was not claimed by the deterministic-only structural rule.
    const visionMajor = makeFinding({
      kind: "hierarchy",
      source: "vision",
      severity: "major",
      tag: "layout",
      message: "unbalanced",
    });
    expect(route({ findings: [contrast, visionMajor], iteration: 0 }, routing, loop)).toBe(
      "repair",
    );
  });

  it("routes a critical UNFIXABLE finding to paint even when a cosmetic fixable finding co-occurs", () => {
    // A content-broken board: missing bindings (critical, no mechanical fix) plus one fixable
    // overflow. Repair can't mend the bindings, so re-paint must outrank the mechanical-fix rule —
    // otherwise the loop budget dies polishing the overflow while the board stays broken.
    const bindingMissing = makeFinding({
      kind: "binding-missing",
      source: "deterministic",
      severity: "critical",
      tag: "structural",
      deterministicallyFixable: false,
      message: "required binding missing",
    });
    const overflowFixable = makeFinding({
      kind: "overflow",
      source: "deterministic",
      severity: "major",
      tag: "layout",
      deterministicallyFixable: true,
      message: "content overflows",
    });
    expect(
      route({ findings: [bindingMissing, overflowFixable], iteration: 0 }, routing, loop),
    ).toBe("paint");
  });
});

describe("route — no-progress escalation (D65)", () => {
  it("suppresses repair-routing when the last repair made no change, escalating to paint", () => {
    // A lone fixable contrast finding normally repairs. But once a repair has proven ineffective
    // (byte-identical output), re-choosing repair would loop forever — so the router skips the
    // repair rule and the decision falls through to a re-paint (the fixable finding is critical, so
    // it also matches actionable-to-repaint).
    expect(route({ findings: [contrast], iteration: 0 }, routing, loop)).toBe("repair");
    expect(
      route({ findings: [contrast], iteration: 1, repairIneffective: true }, routing, loop),
    ).toBe("paint");
  });

  it("suppresses repair for an ineffective fixable overflow, escalating to paint", () => {
    const overflowFixable = makeFinding({
      kind: "overflow",
      source: "deterministic",
      severity: "major",
      tag: "layout",
      deterministicallyFixable: true,
      message: "content overflows",
    });
    expect(route({ findings: [overflowFixable], iteration: 0 }, routing, loop)).toBe("repair");
    expect(
      route({ findings: [overflowFixable], iteration: 1, repairIneffective: true }, routing, loop),
    ).toBe("paint");
  });

  it("still freezes when no non-repair rule matches after suppression", () => {
    // A fixable finding whose only route was repair, now suppressed, and nothing else actionable
    // (a MINOR finding is below every paint rule's threshold) → freeze, not an endless repair.
    const minorFixable = makeFinding({
      kind: "contrast",
      source: "deterministic",
      severity: "minor",
      tag: "mechanical",
      deterministicallyFixable: true,
      message: "borderline contrast",
    });
    expect(
      route({ findings: [minorFixable], iteration: 1, repairIneffective: true }, routing, loop),
    ).toBe("freeze");
  });
});
