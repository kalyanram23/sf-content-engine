import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { themePresetSchema } from "../domain/schemas";

/**
 * Guards the externalized theme bundles (`themes/*.theme.json`). Each is JSON.parsed (so a malformed
 * bundle fails the suite, not just a live run) and validated against `themePresetSchema`. It also
 * enforces D1: no theme `design.identity` may license placeholder/stand-in art for a photoless item
 * — that clause is fed verbatim to BOTH the painter and the critic, so it must not survive.
 */
const themesDir = fileURLToPath(new URL("../../themes", import.meta.url));
const themeFiles = readdirSync(themesDir).filter((f) => f.endsWith(".theme.json"));

describe("theme files", () => {
  it("finds the externalized theme bundles", () => {
    expect(themeFiles.length).toBeGreaterThan(0);
  });

  for (const file of themeFiles) {
    describe(file, () => {
      const raw = readFileSync(`${themesDir}/${file}`, "utf8");

      it("is valid JSON and a valid ThemePreset", () => {
        const parsed: unknown = JSON.parse(raw);
        expect(themePresetSchema.safeParse(parsed).success).toBe(true);
      });

      it("does not license placeholder/stand-in art for photoless items (D1)", () => {
        const parsed = JSON.parse(raw) as { design?: { identity?: string } };
        expect(parsed.design?.identity ?? "").not.toContain("standing in for");
      });
    });
  }
});
