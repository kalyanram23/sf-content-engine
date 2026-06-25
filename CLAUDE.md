# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`content-engine` — a stateless TS (ESM) library that turns a normalized menu into finished
digital-signage screens: `generate({ items, brief, constraints }) → { screens, posters, qaReport }`.
The screen is painted freely by an LLM "on rails", then corrected by a generator–critic QA
loop until it passes (or the iteration budget trips), then frozen. v1 = one screen, one preset
(botanical), hand-authored plan.

The behaviour spec is the source of truth:
`docs/superpowers/specs/2026-06-22-display-content-generation-engine-design.md`.
`ARCHITECTURE.md` documents structure; `DECISIONS.md` logs every interpretation as **D1–D16**
(cite these when changing a load-bearing decision). Read those before non-trivial changes.

## Commands

```bash
npm run verify          # the gate: prettier --check → eslint → tsc --noEmit → vitest run (hermetic)
npm test                # vitest run (unit + e2e, fakes only — no network/browser/key)
npx vitest run src/qa/scoring          # run one test file/dir
npx vitest run -t "never lets it"      # run tests matching a name
npm run build           # tsup → ESM + .d.ts for ., ./node, ./testing
npm run playground      # run the engine on fixtures → ./playground-output (all acceptance scenarios)
npm run test:live       # gated adapter tests; needs OPENROUTER_API_KEY and/or RUN_BROWSER_TESTS=1 (+ npx playwright install chromium)
```

Always run `npm run verify` before claiming done. Adapter (`src/adapters/**`) code is **not** in
the default suite — it's covered by `*.live.test.ts` (gated) plus a hermetic mocked test for the
OpenRouter client and a real-compile test for the Tailwind packager.

## Architecture you must hold in your head

**Pure core + injected ports.** Nothing in the core touches network/browser/clock/randomness —
every external concern is a port interface (`src/ports/`) injected at one composition root.
`createEngine(ports, config)` (`src/pipeline/engine.ts`) is the pure root; `createNodeEngine`
(`src/adapters/node-engine.ts`) wires the real OpenRouter/Playwright/Tailwind adapters. Tests
inject fakes via `createFakeEngine` (`src/testing/fakes/`). If you add a dependency on time/IO,
add a port — don't reach for a global.

**The pipeline is a LangGraph `StateGraph`, isolated to one file.** `src/pipeline/graph.ts` is the
**only** file that imports `@langchain/langgraph`. Nodes (`src/pipeline/nodes/index.ts`) are plain
`(ctx, state) => Promise<Partial<EngineState>>` functions with zero LangGraph knowledge; `graph.ts`
binds `ctx` and wires them. Flow: `plan → resolveTheme → paint → package → deterministicQA →
visionQA → score → route → {repair|paint|plan|freeze}`. `package` is its own node so "QA always
runs on what ships" is structural.

**The router owns termination; `best` is preserved.** `route()` (`src/pipeline/router.ts`) is pure
and the **sole** authority: it returns `"freeze"` the instant `iteration >= loop.maxIterations`.
`recursionLimit` in the graph is only a safety net (a `GraphRecursionError` is treated as a router
bug). The `score` node maintains `best` via an explicit max over the scoring comparator
(`src/qa/scoring.ts`) so a worse later iteration never overwrites the best; `freeze` ships `best`,
flagged if it didn't pass.

**QA is two tiers.** Rendered checks (`src/qa/rendered-checks.ts`: contrast/overflow/density/images/
viewport) are pure functions over a `RenderObservation` the `BrowserPort` produces. Structural
checks (`src/qa/structural-checks.ts`: binding integrity, token-lint, motion-vocab, self-contained +
no-baked-player) parse HTML with `node-html-parser`. WCAG contrast math is `src/qa/contrast.ts`.

**Rules/config are data, not code** (`src/config/`). Routing, token-lint, rubric, QA thresholds,
loop budget, model routing, capacities, required bindings, and `blockingSeverity` are Zod-validated
config interpreted by small evaluators. `loadEngineConfig(partial)` deep-merges over defaults,
validates the model allowlist, and deep-freezes. **Changing engine behaviour usually means editing
config data, not engine code** — keep it that way.

## Conventions and gotchas (these will bite you)

- **Zod 4.** Use `z.toJSONSchema` and `.prefault({})` (not `.default({})`) for all-defaulted nested
  objects. Domain schemas live in `src/domain/schemas.ts`; the strict LLM contracts
  (`src/domain/contracts.ts`) are **separate** from `EngineState` (D2) and must stay
  `additionalProperties:false`-compatible (no top-level unions).
- **`tsconfig` is strict:** `verbatimModuleSyntax` (use `import type` for types — eslint enforces),
  `exactOptionalPropertyTypes` (don't pass `{ field: undefined }`; spread conditionally:
  `...(x !== undefined ? { field: x } : {})`), `noPropertyAccessFromIndexSignature` (bracket-access
  index signatures, e.g. `obj["key"]`).
- **LangGraph node ids must not collide with state channel names.** The plan node is `"planContent"`
  because `plan` is a state channel.
- **token-lint runs on the RAW painter HTML, not the packaged HTML** (compiled Tailwind CSS
  legitimately contains hex). The `deterministicQA` node passes `rawHtml: state.html` alongside the
  packaged `html`. The deterministic contrast repair (`src/repairs/`) must emit
  `var(--color-<token>)`, **never a raw hex**, or it'll trip its own token-lint and re-paint will
  discard it.
- **Hermetic boundary is eslint-enforced.** Only `src/node.ts` and `src/adapters/**` may import the
  optional peers (`openai`, `playwright-core`, `tailwindcss`, `@tailwindcss/node`) or any
  `src/adapters/**` module. Importing them elsewhere fails lint and would make `verify` non-hermetic.
  The main entry (`src/index.ts`) is boundary-only and must have no import side effects.
- **Errors** are the `ContentEngineError` hierarchy (`src/domain/errors.ts`) with stable `code`s;
  validate inputs at boundaries with `parseOrThrow` (`src/domain/parse.ts`).

## Test patterns

The e2e tests (`src/pipeline/engine.test.ts`) drive convergence with **scenario-scripted fakes**:
`ScriptedBrowser` returns a list of `RenderObservation`s (one per render, clamped to the last) and
`ScriptedVisionCritic` returns scripted findings — so "render shows dead space, then clean after the
re-paint" is expressed as `observations: [deadSpaceObservation(), cleanObservation()]`. The
`FakePainter` emits genuinely valid HTML, so structural checks run against real generated markup
while rendered issues are simulated. Reuse `cleanObservation`/`deadSpaceObservation`/
`contrastFailObservation` and `fixtures` from `src/testing/`.
