import { describe, expect, it } from "vitest";

import {
  critiqueResponseSchema,
  planBlockSchema,
  planResponseSchema,
  repairResponseSchema,
} from "./contracts";

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

/**
 * The planner-facing representation enum (E1) is DELIBERATELY narrower than the internal
 * `representationSchema`: it omits "variant-rows" because the id-free menu digest carries no variant
 * signal, so a planner choice of it would be uninformed guessing.
 */
describe("planBlockSchema representation enum (E1)", () => {
  const base = { title: "Curries", categories: ["Veg Curries"], layoutHint: "" };

  it("accepts matrix, grid, and list", () => {
    for (const representation of ["matrix", "grid", "list"] as const) {
      expect(planBlockSchema.safeParse({ ...base, representation }).success).toBe(true);
    }
  });

  it("rejects 'variant-rows'", () => {
    expect(planBlockSchema.safeParse({ ...base, representation: "variant-rows" }).success).toBe(
      false,
    );
  });
});
