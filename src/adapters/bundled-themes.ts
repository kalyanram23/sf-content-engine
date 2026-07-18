import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Resolve the directory containing this package's shipped theme bundles (`themes/*.theme.json`
 * — dhaba, bold-poster, blockframe, bazaar, bubblegum; D71/D78/D79). `createNodeEngine` uses this
 * as the default `themesDir` so a bare `createNodeEngine({ openRouterApiKey })` — the shape a
 * git-dependency consumer reaches for — resolves all six shipped themes, not just the one
 * code-bundled preset (`botanical`).
 *
 * The hop from this module's `import.meta.url` up to the package-root `themes/` directory
 * differs by layout, because tsup bundling changes what `import.meta.url` resolves to at
 * runtime (it's the URL of whichever emitted file the code physically ends up in, not the
 * original source file):
 *  - packed (`dist/node.js`, tsup bundles this module's code inline): `themes/` is a sibling of
 *    `dist/` → one hop up (`../themes`).
 *  - source (this file under `src/adapters/`, unbundled — tests, `npm run try`): `themes/` is at
 *    the package root, two levels above `src/adapters/` → two hops up (`../../themes`).
 *
 * Rather than hard-code either guess, probe both and return whichever exists on disk.
 */
export function bundledThemesDir(): string {
  const oneHop = fileURLToPath(new URL("../themes", import.meta.url));
  if (existsSync(oneHop)) return oneHop;

  const twoHop = fileURLToPath(new URL("../../themes", import.meta.url));
  if (existsSync(twoHop)) return twoHop;

  throw new Error(
    `bundledThemesDir: could not locate the shipped themes/ directory. Probed:\n` +
      `  ${oneHop}\n` +
      `  ${twoHop}`,
  );
}
