import { describe, expect, it } from "vitest";

import { defaultRubric } from "../config/rubric";
import type { QaFinding } from "../domain/types";
import { makeFinding } from "./finding";
import { isBetter, rubricScore, scoreScreen } from "./scoring";

const rubric = defaultRubric();

const contrastFinding = makeFinding({
  kind: "contrast",
  source: "deterministic",
  severity: "critical",
  tag: "mechanical",
  hardGate: true,
  message: "low contrast",
});
const densityFinding = makeFinding({
  kind: "density",
  source: "deterministic",
  severity: "major",
  tag: "layout",
  message: "dead space",
});
const visionMajor = (dimension: string): QaFinding =>
  makeFinding({
    kind: dimension,
    source: "vision",
    severity: "major",
    tag: "layout",
    message: dimension,
  });

describe("scoreScreen", () => {
  it("passes a clean screen with a perfect rubric", () => {
    const score = scoreScreen([], rubric);
    expect(score.passed).toBe(true);
    expect(score.rubricScore).toBe(1);
    expect(score.hardGateFailures).toBe(0);
  });

  it("fails on a blocking (major+) deterministic finding", () => {
    expect(scoreScreen([densityFinding], rubric).passed).toBe(false);
  });

  it("honours a configurable blocking severity for deterministic findings (rules-as-data)", () => {
    // With the threshold raised to critical, a major deterministic finding no longer blocks.
    expect(scoreScreen([densityFinding], rubric, "critical").passed).toBe(true);
    // ...but a critical deterministic finding still blocks.
    const criticalDeterministic = makeFinding({
      kind: "x",
      source: "deterministic",
      severity: "critical",
      tag: "content",
      message: "c",
    });
    expect(scoreScreen([criticalDeterministic], rubric, "critical").passed).toBe(false);
  });

  it("grades vision findings by the rubric — a lone critic nit never hard-blocks a good screen", () => {
    // One reflexive vision "major" must not block a pass (weighted rubric stays above threshold).
    expect(scoreScreen([visionMajor("balance")], rubric).passed).toBe(true);
    // ...but enough failed dimensions drop the rubric below threshold and the screen fails.
    const many = ["balance", "hierarchy", "representation-clarity"].map(visionMajor);
    expect(scoreScreen(many, rubric).passed).toBe(false);
  });

  it("tolerates info/minor findings", () => {
    const minor = makeFinding({
      kind: "x",
      source: "vision",
      severity: "minor",
      tag: "content",
      message: "m",
    });
    expect(scoreScreen([minor], rubric).passed).toBe(true);
  });

  it("drops the rubric score when a weighted dimension fails", () => {
    expect(rubricScore([visionMajor("balance")], rubric)).toBeLessThan(1);
  });
});

describe("isBetter — best-so-far never regresses (D12)", () => {
  it("ranks a clean screen above one with a hard-gate failure", () => {
    const clean = scoreScreen([], rubric);
    const gated = scoreScreen([contrastFinding], rubric);
    expect(isBetter(clean, gated)).toBe(true);
    expect(isBetter(gated, clean)).toBe(false);
  });

  it("ranks fewer/less-severe findings above more", () => {
    const oneMajor = scoreScreen([densityFinding], rubric);
    const twoMajor = scoreScreen([densityFinding, visionMajor("hierarchy")], rubric);
    expect(isBetter(oneMajor, twoMajor)).toBe(true);
  });

  it("hard-gate failures dominate the penalty term", () => {
    // A screen with many minor issues but no hard gate still beats one hard-gated screen.
    const manyMinor = scoreScreen(
      Array.from({ length: 5 }, (_, i) =>
        makeFinding({
          kind: `v${i}`,
          source: "vision",
          severity: "minor",
          tag: "content",
          message: "m",
        }),
      ),
      rubric,
    );
    const gated = scoreScreen([contrastFinding], rubric);
    expect(isBetter(manyMinor, gated)).toBe(true);
  });
});

describe("gate-blocked candidates sort below non-blocked ones (D27)", () => {
  const visionMajors = (n: number): QaFinding[] =>
    Array.from({ length: n }, (_, i) => visionMajor(`v${i}`));

  it("ranks any non-blocked candidate above a gate-blocked one, regardless of penalty weight", () => {
    // The blocked candidate is penalty-LIGHT (its vision critique was skipped): a single
    // deterministic density major. The non-blocked candidate is loaded with vision penalties that
    // never gate. Without the dedicated blocked term the light one would win the raw-penalty
    // comparison and corrupt `best`.
    const blockedLight = scoreScreen([densityFinding], rubric);
    const nonBlockedHeavy = scoreScreen(visionMajors(8), rubric);
    expect(nonBlockedHeavy.penalty).toBeGreaterThan(blockedLight.penalty);
    expect(isBetter(nonBlockedHeavy, blockedLight)).toBe(true);
    expect(isBetter(blockedLight, nonBlockedHeavy)).toBe(false);
  });

  it("preserves blocked-vs-blocked ordering (fewer/less-severe deterministic findings win)", () => {
    const overflowFinding = makeFinding({
      kind: "overflow",
      source: "deterministic",
      severity: "major",
      tag: "layout",
      message: "overflow",
    });
    const oneBlocking = scoreScreen([densityFinding], rubric);
    const twoBlocking = scoreScreen([densityFinding, overflowFinding], rubric);
    expect(isBetter(oneBlocking, twoBlocking)).toBe(true);
  });

  it("preserves clean-vs-clean ordering (no blocked term when nothing gates)", () => {
    const cleaner = scoreScreen(visionMajors(1), rubric);
    const messier = scoreScreen(visionMajors(2), rubric);
    expect(isBetter(cleaner, messier)).toBe(true);
  });
});
