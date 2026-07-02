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
