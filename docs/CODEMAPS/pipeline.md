<!-- Generated: 2026-06-28 | Files scanned: src/pipeline/** | Token estimate: ~850 -->

# Pipeline (LangGraph StateGraph)

One graph runs **per board**. `src/pipeline/graph.ts` is the **only** file importing
`@langchain/langgraph`; nodes are plain `(ctx, state) => Promise<Partial<EngineState>>`
(`src/pipeline/nodes/index.ts`), LangGraph-free (D2). `ctx = { ports, config }`.

## Flow

```
START ▶ planContent ▶ resolveTheme ▶ fetchImages ▶ paint ▶ package ▶ deterministicQA ▶ visionQA ▶ score
                                            ▲                                                      │
                          repair ◀──────────┤                                           route (conditional)
                          paint  ◀──────────┤            { repair | paint | plan | freeze }
                          planContent ◀─────┘                                                      │
                                                                              freeze ▶ END ◀───────┘
```

Node id is `planContent` (not `plan`) — must not collide with the `plan` state channel.
`package` is its own node so QA always runs on **what ships** (structural invariant).

## Node → implementation → port

```
planContent      planNode          ports.planner.plan          (skips if state.plan present)
resolveTheme     resolveThemeNode  ports.themeRepository.get → resolveTheme() (brief perturb)
fetchImages      fetchImagesNode   ports.imageFetcher.fetch    remote photos → data: URIs (offline)
paint            paintNode         ports.painter.paint         minimal-change on re-paint; ++iteration
package          packageNode       ports.packager.package      compile Tailwind + inline → self-contained
deterministicQA  deterministicQaNode ports.browser.render + runStructuralChecks + runRenderedChecks
visionQA         visionQaNode      ports.visionCritic.critique skipped if a hard gate already failed
score            scoreNode         qa/scoring.scoreScreen + router.route + ports.debug?.capture
repair           repairNode        repairs.applyDeterministicRepairs (pure) → ports.llmRepairer? (fallback)
freeze           freezeNode        emits FrozenScreen { screen, poster, report } from `best`
```

## Routing & termination (`src/pipeline/router.ts`, PURE, sole authority — D12)

```
route(input, routing, loop):
  iteration >= loop.maxIterations → "freeze"   # budget enforced here, before any re-entry
  passed === true                 → "freeze"   # a passing board needs no more work
  else selectRoute(findings, routing.rules) ?? "freeze"   # highest-priority matching rule
```

`recursionLimit` in the graph is only a safety net; a `GraphRecursionError` is a router bug
(engine wraps it as `INTERNAL`). Routing rules are config-as-data (`src/config/routing.ts`).

## State channels (`src/pipeline/state.ts`, last-value-wins)

```
input(const) · screenIndex · plan? · theme? · resolvedItems? · html? · packagedHtml?
screenshotBase64? · findings[] · iteration · route? · routeHistory[] · best? · frozen?
```

`best` is maintained by an explicit max over the score comparator in `scoreNode` (D12) — a worse
later iteration never overwrites it; `freeze` ships `best`, `flagged` if it didn't pass.

## Orchestration (`src/pipeline/engine.ts`)

`generate()`: parse → `resolvePlan` (caller `plan` else `ports.planner.plan`) → assert
`constraints.screens` matches board count → render each board sequentially → parse `GenerateOutput`.
