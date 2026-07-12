<!-- Generated: 2026-07-11 | Files scanned: 86 non-test src .ts | Token estimate: ~820 -->

# Architecture

**Type:** stateless TypeScript (ESM) **library** — no server, no DB, no UI. Published with 3
entry points; consumed by a Next.js service. Authoritative prose: `ARCHITECTURE.md`, `DECISIONS.md`
(D1–D70), spec `docs/superpowers/specs/2026-06-22-…-design.md`.

## What it does

```
generate({ items, brief, constraints }) → { screens, posters, qaReport }
```

LLM **plans** the menu across N boards → each board is **painted** as free HTML "on rails" →
**packaged** self-contained → corrected by a **generator–critic QA loop** → **frozen** (best wins).

## Entry points (package.json exports → src)

```
.          src/index.ts    pure, no side effects, boundary-only (D16): schemas, types, errors,
                           config-as-data, port types, createEngine, theme presets
./node     src/node.ts     Node-only: createNodeEngine + real adapters (pulls optional peers)
./testing  src/testing.ts  createFakeEngine + fixtures (deterministic, no network/browser)
```

## Composition roots (only place ports are constructed)

```
createEngine(ports, config)     src/pipeline/engine.ts          PURE root — injects EnginePorts
  ├─ createNodeEngine(opts)      src/adapters/node-engine.ts     PROD: OpenRouter/Playwright/Tailwind;
  │                                                              +usage telemetry, opt-in Braintrust,
  │                                                              brand-logo → data-URI (D18)
  ├─ createClaudeCodeEngine(opts) src/adapters/claudecode/engine.ts  TEST/LOCAL ONLY: Claude-Agent-SDK
  │                                                              LLM adapters (subscription auth, no
  │                                                              OpenRouter key) + real Playwright/Tailwind
  └─ createFakeEngine()          src/testing/fakes/index.ts      scripted fakes for tests
```

## Layering (dependency direction ↓)

```
boundary entries   src/index.ts · src/node.ts · src/testing.ts
pure core          src/pipeline/ (engine, graph, nodes, router, state)
                   src/qa/ · src/repairs/ · src/planning/ · src/theme/ · src/domain/ · src/config/ · src/util/
ports (interfaces) src/ports/*           ← core depends only on these
adapters (real)    src/adapters/**       ← implement ports; may import optional peers
```

**Hermetic boundary (eslint-enforced):** only `src/node.ts` + `src/adapters/**` may import the
optional peers (`openai`, `playwright-core`, `tailwindcss`, `@tailwindcss/node`) or any adapter.
The default test suite touches no network/browser/key.

## Data flow

```
GenerateInput ──parse──▶ engine.generate()   (Node root first resolves brand logo → data-URI)
  resolvePlan (caller plan | Planner port) ─▶ ThinPlan (N PlanScreens)
  menu-lint (D29) ─▶ warn/reject/off ; zero-price render policy applied
  for each board i:  graph.invoke({input, plan, screenIndex:i}) ─▶ FrozenScreen
GenerateOutput { screens[], posters[], qaReport } ◀──parse── frozen[]
```

Boards render **sequentially by default** (`config.execution.boardConcurrency`, default 1 — the
scripted-fake e2e tests consume observations in call order; each board is an independent graph
thread/checkpointer/best, so >1 is safe). `engine.plan(input)` exposes plan resolution alone.

## See also

`pipeline.md` (graph/nodes/routing) · `ports.md` (DI seam) · `qa.md` (checks/gate/scoring/repair) ·
`dependencies.md` (peers/services).
