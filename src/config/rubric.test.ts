import { describe, expect, it } from "vitest";

import { defaultRubric } from "./rubric";

describe("invented-copy rubric dimension", () => {
  it("explicitly names footnotes and legends so the judge treats them as invented copy", () => {
    // Cheap regression pin: two consecutive runs shipped fabricated legend/footnote lines without an
    // invented-copy finding because the dimension never called them out. Keep the wording present.
    const dim = defaultRubric().dimensions.find((d) => d.id === "invented-copy");
    expect(dim).toBeDefined();
    const desc = dim!.description.toLowerCase();
    expect(desc).toContain("footnote");
    expect(desc).toContain("legend");
  });
});
