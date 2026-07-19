<!-- Generated: 2026-07-12 | Files scanned: 103 non-test src .ts | Token estimate: ~1000 -->

# Architecture

**Type:** stateless TypeScript (ESM) **library** — no server, no DB, no UI. Published with 3
entry points; consumed by a Next.js service. Authoritative prose: `ARCHITECTURE.md`, `DECISIONS.md`
(D1–D77), spec `docs/superpowers/specs/2026-06-22-…-design.md`.

## What it does

```
generate({ items, brief, constraints }) → { screens, posters, qaReport }
```

LLM **plans** the menu across N boards → each board is **painted** (free-paint OR composed) →
**packaged** self-contained → corrected by a **generator–critic QA loop** → **frozen** (best wins).

## Entry points (package.json exports → src)

```
.          src/index.ts    pure, no side effects, boundary-only (D16): schemas, types, errors,
                           config-as-data, port types, createEngine, botanicalPreset
./node     src/node.ts     Node-only: createNodeEngine + real adapters (pulls optional peers)
./testing  src/testing.ts  createFakeEngine + fixtures (deterministic, no network/browser)
```

## Composition roots (only place ports are constructed)

```
createEngine(ports, config)      src/pipeline/engine.ts          PURE root — injects EnginePorts
  ├─ createNodeEngine(opts)      src/adapters/node-engine.ts     PROD: OpenRouter/Playwright/Tailwind;
  │                                                              painter = AutoPainter{free,composition};
  │                                                              +usage telemetry, opt-in Braintrust,
  │                                                              brand-logo → data-URI (D18)
  ├─ createClaudeCodeEngine(opts) src/adapters/claudecode/engine.ts  GITIGNORED / not in a fresh clone:
  │                                                              shelved Claude-Agent-SDK adapters
  │                                                              (subscription auth, no OpenRouter
  │                                                              key); free paint only, out of the gate
  └─ createFakeEngine()          src/testing/fakes/index.ts      scripted fakes (+ FakeComposer +
                                                                 builtinVocabularies, mode "auto")
```

## Paint: two paths behind one `Painter` port (D71)

```
AutoPainter (src/composition/auto-painter.ts) picks per board from config.painter.mode:
  auto (default)  theme declares `vocabulary` → COMPOSE, else → FREE; compose failure rescues to free
  free            always free-paint (§2.3: LLM writes arbitrary HTML on the rails)
  composition     force compose — fails loud (needs ports.composer + a registered vocabulary)

COMPOSE = LLM Composer port fills a 3-kind structured order (section | group | photoBand)
          → deterministic render in src/composition/ (layout · renderer · digest · painter)
          → engine-legal markup w/ `data-composed`; graph/packager unchanged, QA *trusts* it
            against hand-authored-only checks (token-lint + matrix-structure) — D73/D76
          landscape boards use BrowserPort.measure for real column heights (D72/D77)

new ports:    src/ports/composer.ts · src/ports/vocabulary-registry.ts (ComponentVocabulary)
new adapter:  src/adapters/openrouter/composer.ts (OpenRouterComposer, `compose` model role)
vocabularies: src/vocabularies/index.ts (builtinVocabularies) · dhaba/index.ts
themes/:      bazaar · blockframe · bold-poster · botanical · bubblegum · dhaba
              (only `dhaba` declares a `vocabulary` → only dhaba composes)
```

## Layering (dependency direction ↓)

```
boundary entries   src/index.ts · src/node.ts · src/testing.ts
pure core          src/pipeline/ (engine, graph, nodes, router, state)
                   src/qa/ · src/repairs/ · src/planning/ · src/composition/ · src/vocabularies/
                   src/theme/ · src/domain/ · src/config/ · src/util/
ports (interfaces) src/ports/*           ← core depends only on these
adapters (real)    src/adapters/**       ← implement ports; may import optional peers
```

**Hermetic boundary (eslint-enforced):** only `src/node.ts` + `src/adapters/**` may import the
optional peers (`openai`, `playwright-core`, `tailwindcss`, `@tailwindcss/node`) or any adapter.
The default test suite touches no network/browser/key.

## Data flow

```
GenerateInput ──parse──▶ engine.generate()   (Node root first resolves brand logo → data-URI)
  menu-lint (D29) ─▶ warn/reject/off ; zero-price render policy applied
  resolvePlan (caller plan | Planner port) ─▶ ThinPlan (N PlanScreens)
  for each board i:  graph.invoke({input, plan, screenIndex:i, runId}) ─▶ FrozenScreen
GenerateOutput { screens[], posters[], qaReport } ◀──parse── results[]
```

Boards render **sequentially by default** (`config.execution.boardConcurrency`, default 1 — the
scripted-fake e2e tests consume observations in call order; each board is an independent graph
thread/checkpointer/best, so >1 is safe). A board's terminal failure is **bulkheaded** (D28): it
becomes an error report and the rest of the fleet still ships. `engine.plan(input)` exposes plan
resolution alone.

## See also

`pipeline.md` (graph/nodes/routing) · `ports.md` (DI seam) · `qa.md` (checks/gate/scoring/repair) ·
`dependencies.md` (peers/services).
