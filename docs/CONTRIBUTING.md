# Contributing

`content-engine` is a stateless TypeScript (ESM) library. This guide covers the mechanics of
working in the repo — setup, the commands, and the checks a change must pass. For **how the code
is organized and why**, the deeper sources are:

- **[`CLAUDE.md`](../CLAUDE.md)** — the architecture you must hold in your head, plus the
  conventions and gotchas that will bite you (Zod 4, strict `tsconfig`, the hermetic boundary).
  Treat it as the source of truth for conventions; this file does not duplicate it.
- **[`ARCHITECTURE.md`](../ARCHITECTURE.md)** — structure and "how to extend".
- **[`DECISIONS.md`](../DECISIONS.md)** — every load-bearing interpretation logged as `D1…Dn`
  (cite the relevant `D` when you change one).
- **[`docs/CODEMAPS/`](./CODEMAPS/)** — auto-generated module maps (regenerate with
  `/update-codemaps`; don't hand-edit — they carry a `Generated:` header).

## Prerequisites

- **Node ≥ 20** (`package.json` `engines`). Node 22+ is handy for `--env-file` in your own scripts.
- The hermetic test suite needs **no** API key, browser, or network — it runs entirely on fakes.
- Only the **Node adapters and live tests** need env or the optional peers. To run those:
  ```bash
  cp .env.example .env          # fill in OPENROUTER_API_KEY
  npm install                   # optional peers (openai, playwright-core, tailwindcss) are dev-installed here
  npx playwright install chromium   # only if you set RUN_BROWSER_TESTS=1
  ```
  See [`.env.example`](../.env.example) for what each variable does. Model routing is **not** env —
  it's config-as-data (`createNodeEngine({ config: { models: … } })`).

## The gate

`npm run verify` is what CI runs and what "done" means. It is **hermetic** — no network, browser,
or key — because it runs on fakes.

<!-- AUTO-GENERATED:verify (from package.json `verify` script — regenerate, don't hand-edit) -->

```
npm run verify  =  prettier --check .   →   eslint .   →   tsc --noEmit   →   vitest run
                   (format)                 (lint)         (typecheck)        (test)
```

<!-- /AUTO-GENERATED:verify -->

Run it before opening a PR. If formatting is the only failure, `npm run format` fixes it in place.

**Adapter code (`src/adapters/**`) is not in the default suite** — it's covered by gated
`*.live.test.ts` files (`npm run test:live`, needs a key and/or a browser) plus a hermetic mocked
test for the OpenRouter client and a real-compile test for the Tailwind packager.

## Scripts

<!-- AUTO-GENERATED:scripts (from package.json — regenerate, don't hand-edit) -->

| Command                 | What                                                                       |
| ----------------------- | -------------------------------------------------------------------------- |
| `npm run verify`        | The gate: format-check → lint → typecheck → test (hermetic).               |
| `npm test`              | `vitest run` — unit + e2e on fakes (no network/browser/key).               |
| `npm run test:watch`    | `vitest` in watch mode.                                                     |
| `npm run test:coverage` | `vitest run --coverage`.                                                    |
| `npm run test:live`     | Gated adapter tests (needs `OPENROUTER_API_KEY` and/or `RUN_BROWSER_TESTS`).|
| `npm run typecheck`     | `tsc --noEmit`.                                                             |
| `npm run lint`          | `eslint .`.                                                                 |
| `npm run format`        | `prettier --write .` (fix). `format:check` is the read-only variant.       |
| `npm run build`         | `prebuild` bakes the motion bundle, then `tsup` → ESM + `.d.ts` for the 3 entries. |
| `npm run playground`    | Run the engine on fixtures → `./playground-output` (all acceptance scenarios). |
| `npm run try`           | Drive the real Node engine on a menu end-to-end (needs a key). `try:debug` is the inspector variant. |
| `npm run try:claude`    | **Local-only.** Drives the Claude-Agent-SDK backend. Its adapter (`src/adapters/claudecode/**`) and script are **gitignored** — a fresh clone does not have them, so this script will not run. |
| `npm run eval`          | Run the eval harness (`scripts/evals/`) → `eval-output/scorecard.md`.       |
| `npm run regen:samples` | Regenerate the `samples/` fixtures from source menus.                       |
| `npm run vocab:samples` | Density-proof renders for one vocabulary (`-- <id>`): 5/20/50 items × portrait/landscape (needs Playwright chromium). |
| `npm run build:motion`  | Bake the motion bundle (also runs automatically as `prebuild`).            |
| `npm run build:full-plan` | Build a hand-authored full plan (`scripts/build-full-plan.ts`).          |
| `npm run embed:fonts`   | Embed fonts as data-URIs (`scripts/embed-fonts.ts`).                        |

<!-- /AUTO-GENERATED:scripts -->

## Code style & conventions

Style is enforced, not documented — `prettier` and `eslint` are part of the gate. The load-bearing
constraints (read **[`CLAUDE.md`](../CLAUDE.md)** for the full list and the reasons):

- **`tsconfig` is strict**: `verbatimModuleSyntax` (use `import type` for types — eslint enforces),
  `exactOptionalPropertyTypes` (don't pass `{ field: undefined }`; spread conditionally),
  `noPropertyAccessFromIndexSignature` (bracket-access index signatures).
- **Pure core + injected ports.** Nothing in the core touches network/browser/clock/randomness — add
  a **port** (`src/ports/`) rather than reaching for a global. Wire real adapters at the
  Node composition root and fakes at the test root.
- **Hermetic boundary is eslint-enforced.** Only `src/node.ts` and `src/adapters/**` may import the
  optional peers (`openai`, `playwright-core`, `tailwindcss`, `@tailwindcss/node`). Importing them
  elsewhere fails lint and makes `verify` non-hermetic.
- **Behaviour usually changes in config data, not engine code** (`src/config/`). Routing, thresholds,
  rubric, model routing, and loop budget are Zod-validated data interpreted by small evaluators.

## Pull request checklist

- [ ] `npm run verify` passes locally (format, lint, typecheck, tests — all hermetic).
- [ ] New behaviour has tests; e2e convergence uses the scenario-scripted fakes
      (`ScriptedBrowser` / `ScriptedVisionCritic`) — see the test-patterns section of `CLAUDE.md`.
- [ ] Any external concern (time/IO/network/randomness) is behind a **port**, not a global.
- [ ] A load-bearing interpretation you changed is logged in `DECISIONS.md` (cite the `D` number).
- [ ] Docs touched if a source of truth changed: the `AUTO-GENERATED` blocks in `README.md`
      (env from `.env.example`, scripts from `package.json`) and this file stay in sync;
      regenerate `docs/CODEMAPS/` with `/update-codemaps` if module structure moved.
