import { describe, expect, it } from "vitest";

import { critiqueResponseSchema, planResponseSchema, repairResponseSchema } from "./contracts";

describe("LLM contract schemas", () => {
  it("accepts a valid plan response", () => {
    const result = planResponseSchema.safeParse({
      screens: [{ id: "s1", sections: [{ title: "T", representation: "list", items: ["a"] }] }],
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid critique response and rejects an unknown tag", () => {
    expect(
      critiqueResponseSchema.safeParse({
        findings: [
          { dimension: "balance", severity: "major", tag: "layout", region: "top", message: "x" },
        ],
      }).success,
    ).toBe(true);

    expect(
      critiqueResponseSchema.safeParse({
        findings: [
          {
            dimension: "balance",
            severity: "major",
            tag: "mechanical",
            region: "top",
            message: "x",
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("accepts a valid repair response", () => {
    expect(repairResponseSchema.safeParse({ html: "<main></main>", note: "fixed" }).success).toBe(
      true,
    );
    expect(repairResponseSchema.safeParse({ html: "", note: "x" }).success).toBe(false);
  });
});
