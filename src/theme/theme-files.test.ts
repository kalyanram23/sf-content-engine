import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";

import { defaultTokenLintRules } from "../config/token-lint";
import { themePresetSchema } from "../domain/schemas";
import type { StructuralContext } from "../qa/structural-checks";
import { checkTokenLint } from "../qa/structural-checks";

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

      // D66: a theme's exemplar is shown to the painter as the "this is what great looks like"
      // reference, so it MUST itself be legal under the engine's own token-lint (no raw hex/px) —
      // otherwise the gold board would teach the painter the exact violations the rail rejects.
      it("has an exemplar (if any) that passes the engine token-lint (D66)", () => {
        const parsed = JSON.parse(raw) as {
          design?: { exemplar?: { html?: string } };
        };
        const html = parsed.design?.exemplar?.html;
        if (html === undefined) return; // exemplars are optional
        const findings = checkTokenLint(parse(html), {
          tokenLint: defaultTokenLintRules(),
        } as StructuralContext);
        expect(findings).toEqual([]);
      });
    });
  }
});

// The dhaba exemplar is the reason D66 exists — pin that it is actually present, so the token-lint
// guard above is not vacuously satisfied by a missing exemplar.
describe("dhaba theme exemplar", () => {
  it("ships a gold exemplar board", () => {
    const raw = readFileSync(`${themesDir}/dhaba.theme.json`, "utf8");
    const parsed = JSON.parse(raw) as {
      design?: { exemplar?: { aspect?: string; html?: string } };
    };
    expect(parsed.design?.exemplar?.aspect).toBe("9:16");
    expect(parsed.design?.exemplar?.html ?? "").toContain("data-item-id");
  });
});
