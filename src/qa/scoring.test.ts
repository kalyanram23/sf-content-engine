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

  it("fails on a blocking (major+) finding", () => {
    expect(scoreScreen([densityFinding], rubric).passed).toBe(false);
  });

  it("honours a configurable blocking severity (rules-as-data)", () => {
    // With the threshold raised to critical, a major finding no longer blocks a pass.
    expect(scoreScreen([densityFinding], rubric, "critical").passed).toBe(true);
    // ...but a critical finding still blocks.
    const critical = makeFinding({
      kind: "x",
      source: "vision",
      severity: "critical",
      tag: "content",
      message: "c",
    });
    expect(scoreScreen([critical], rubric, "critical").passed).toBe(false);
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
