import { describe, expect, it } from "vitest";

import { ValidationError } from "../domain/errors";
import { botanicalPreset, InMemoryThemeRepository } from "./presets/index";
import { resolveTheme } from "./resolve";

describe("resolveTheme", () => {
  it("defaults density to balanced and keeps preset tokens", () => {
    const resolved = resolveTheme(botanicalPreset, { presetId: "botanical" });
    expect(resolved.density).toBe("balanced");
    expect(resolved.tokens.colors["accent"]).toBe(botanicalPreset.tokens.colors["accent"]);
    expect(resolved.motion).toEqual(botanicalPreset.motion);
  });

  it("applies palette overrides and the density/motif perturbations", () => {
    const resolved = resolveTheme(botanicalPreset, {
      presetId: "botanical",
      palette: { accent: "#112233" },
      density: "airy",
      motif: "ferns",
    });
    expect(resolved.tokens.colors["accent"]).toBe("#112233");
    expect(resolved.density).toBe("airy");
    expect(resolved.motif).toBe("ferns");
  });

  it("does not mutate the source preset", () => {
    const before = botanicalPreset.tokens.colors["accent"];
    resolveTheme(botanicalPreset, { presetId: "botanical", palette: { accent: "#000000" } });
    expect(botanicalPreset.tokens.colors["accent"]).toBe(before);
  });

  it("throws a structured error on an invalid preset", () => {
    const broken = { ...botanicalPreset, motion: [] };
    expect(() => resolveTheme(broken, { presetId: "botanical" })).toThrow(ValidationError);
  });
});

describe("InMemoryThemeRepository", () => {
  it("resolves a known preset and returns undefined for an unknown one", async () => {
    const repo = new InMemoryThemeRepository();
    expect((await repo.get("botanical"))?.id).toBe("botanical");
    expect(await repo.get("nope")).toBeUndefined();
  });
});
