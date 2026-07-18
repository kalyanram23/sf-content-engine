import { readdirSync, statSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { bundledThemesDir } from "./bundled-themes";

/**
 * Hermetic: runs from the SOURCE layout (this test file lives under `src/adapters/`, unbundled
 * by tsup), so it pins the "two hops up" branch of the probing logic (`../../themes` from
 * `src/adapters/bundled-themes.ts` → package-root `themes/`). The packed-layout branch (one hop
 * up from the emitted `dist/node.js`) is evidenced separately via `npm pack --dry-run` — see the
 * task report — since exercising the actual tsup output isn't hermetic-suite material.
 */
describe("bundledThemesDir", () => {
  it("resolves an existing directory containing all six shipped theme bundles", () => {
    const dir = bundledThemesDir();

    expect(statSync(dir).isDirectory()).toBe(true);
    const files = readdirSync(dir);
    // The five composed themes a git-dep consumer's live smoke hit ThemeNotFoundError on
    // (D71/D78/D79), plus botanical's JSON twin of the code-bundled preset.
    for (const id of ["dhaba", "bold-poster", "blockframe", "bazaar", "bubblegum", "botanical"]) {
      expect(files, `${id}.theme.json should be in the bundled themes dir`).toContain(
        `${id}.theme.json`,
      );
    }
  });
});
