import { describe, expect, it } from "vitest";

import { resolveTheme } from "../../theme/resolve";
import { botanicalPreset } from "../../theme/presets/botanical";
import { checkSelfContained } from "../../qa/structural-checks";
import { parse } from "node-html-parser";
import { TailwindPackager } from "./packager";

const theme = resolveTheme(botanicalPreset, { presetId: "botanical" });

describe("TailwindPackager (real compile, hermetic)", () => {
  it("compiles utilities, injects token vars, and emits a self-contained document", async () => {
    const html = `<main class="flex gap-4 p-6 rounded-md"><h2 class="text-text">Hi</h2><span class="text-price">$1.00</span></main>`;
    const packaged = await new TailwindPackager().package({ html, theme });

    expect(packaged).toContain("<!doctype html>");
    expect(packaged).toContain("<style>");
    // A compiled utility from the candidate set is present.
    expect(packaged).toMatch(/\.flex\s*\{[^}]*display\s*:\s*flex/);
    // Theme colour tokens are exposed as CSS variables (used by the contrast repair).
    expect(packaged).toContain("--color-bg");
    // The Motion runtime marker is inlined (offline-safe, D14).
    expect(packaged).toContain("data-motion-runtime");

    // No external references survived (self-contained / offline-safe, §5.1).
    const findings = checkSelfContained(parse(packaged));
    expect(findings).toEqual([]);
  }, 60_000);
});
