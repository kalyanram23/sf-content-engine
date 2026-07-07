import { describe, expect, it } from "vitest";

import { defaultRubric } from "../../config/rubric";
import type { CritiqueRequest } from "../../ports/vision-critic";
import { rubricText } from "./vision-critic";

/**
 * Hermetic (no network): the critic user prompt is assembled by `rubricText`. The optional
 * `canvas` block tells the critic the exact target frame + orientation (D19), so a portrait 9:16
 * board is judged for fill/balance as a tall poster rather than a landscape one. Guards that the
 * block appears only when a canvas is supplied and names the right orientation.
 */
const baseRequest = (canvas?: CritiqueRequest["canvas"]): CritiqueRequest => ({
  screenshotBase64: "AAAA",
  planScreen: {
    id: "screen-1",
    sections: [{ title: "MAINS", representation: "list", items: ["a"] }],
  },
  rubric: defaultRubric(),
  ...(canvas !== undefined ? { canvas } : {}),
});

describe("rubricText canvas block", () => {
  it("omits the canvas line when no canvas is supplied", () => {
    expect(rubricText(baseRequest())).not.toContain("Target canvas:");
  });

  it("states a portrait target for a 9:16 canvas", () => {
    const text = rubricText(baseRequest({ width: 1080, height: 1920, aspect: "9:16" }));
    expect(text).toContain("Target canvas: 1080x1920px (aspect 9:16)");
    expect(text).toContain("portrait");
  });

  it("states a landscape target for a 16:9 canvas", () => {
    const text = rubricText(baseRequest({ width: 1920, height: 1080, aspect: "16:9" }));
    expect(text).toContain("Target canvas: 1920x1080px (aspect 16:9)");
    expect(text).toContain("landscape");
  });
});

/**
 * The density block (D30): a dense/packed board must be judged AS a dense board — its compact,
 * hero-less register is required by the plan, not a flaw. A comfortable board gets no block.
 */
describe("rubricText density block (D30)", () => {
  const withDensity = (
    densityTier: "comfortable" | "dense" | "packed",
    itemCount?: number,
  ): CritiqueRequest => ({
    ...baseRequest(),
    densityTier,
    ...(itemCount !== undefined ? { itemCount } : {}),
  });

  it("omits the block for a comfortable board", () => {
    expect(rubricText(withDensity("comfortable"))).not.toContain("DENSITY:");
  });

  it("tells the critic to judge a dense board as a well-executed dense board", () => {
    const text = rubricText(withDensity("dense", 42));
    expect(text).toContain("DENSITY:");
    expect(text).toContain("DENSE board");
    expect(text).toContain("42 menu items");
    expect(text).toMatch(/WELL-EXECUTED dense board/i);
  });

  it("names the packed tier", () => {
    expect(rubricText(withDensity("packed", 60))).toContain("PACKED board");
  });
});

/**
 * Plan slimming (B1) + imageSlot gloss (D2). The critic's serialized plan drops each NON-matrix
 * section's stale free-text `layoutHint` (the authoritative layout direction is the LAYOUT STRATEGY
 * + DENSITY blocks), but KEEPS it on matrix sections (MATRIX_FIRST_STRATEGY references it) and — the
 * critical asymmetry vs. the painter — KEEPS `imageSlot` (the shared carousel is a QA-enforced anchor
 * the critic must verify, D38/D50), glossed by a line placed immediately before the Plan.
 */
describe("rubricText plan slimming (B1) + imageSlot gloss (D2)", () => {
  const planScreen: CritiqueRequest["planScreen"] = {
    id: "screen-1",
    sections: [
      {
        title: "MAINS",
        representation: "list",
        items: ["a"],
        layoutHint: "STALE-LIST-HINT photo grid — do not follow",
        imageSlot: { kind: "photos", items: ["a"] },
      },
      {
        title: "BIRYANI × PULAV",
        representation: "matrix",
        items: ["b"],
        layoutHint: "KEEP-MATRIX-HINT price table rows=base dish",
        matrix: { columns: ["Biryani", "Pulav"], rows: [{ label: "Chicken", cells: ["b", null] }] },
      },
      {
        // representation is not "matrix" but a computed `matrix` is attached → still a matrix section.
        title: "COMBO",
        representation: "list",
        items: ["c"],
        layoutHint: "KEEP-MATRIXFIELD-HINT",
        matrix: { columns: ["X"], rows: [{ label: "r", cells: ["c"] }] },
      },
    ],
  };
  const text = rubricText({ ...baseRequest(), planScreen });

  it("strips a non-matrix section's stale layoutHint from the serialized plan", () => {
    expect(text).not.toContain("STALE-LIST-HINT");
  });

  it("keeps a matrix-representation section's layoutHint", () => {
    expect(text).toContain("KEEP-MATRIX-HINT");
  });

  it("keeps a matrix-by-computed-field section's layoutHint", () => {
    expect(text).toContain("KEEP-MATRIXFIELD-HINT");
  });

  it("keeps imageSlot for the critic (the shared carousel is a required, QA-enforced anchor)", () => {
    expect(text).toContain('"imageSlot"');
    expect(text).toContain('"kind":"photos"');
  });

  it("emits the imageSlot gloss immediately before the serialized Plan", () => {
    expect(text).toContain(
      "imageSlot lists the photo-item ids that feed the SINGLE shared photo panel/carousel",
    );
    expect(text.indexOf("imageSlot lists the photo-item ids")).toBeLessThan(text.indexOf("Plan:"));
  });
});
