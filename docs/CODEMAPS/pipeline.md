<!-- Generated: 2026-07-11 | Files scanned: src/pipeline/** | Token estimate: ~880 -->

# Pipeline (LangGraph StateGraph)

One graph runs **per board**. `src/pipeline/graph.ts` is the **only** file importing
`@langchain/langgraph`; nodes are plain `(ctx, state) => Promise<Partial<EngineState>>`
(`src/pipeline/nodes/index.ts`, helpers in `nodes/shared.ts`), LangGraph-free (D2).
`ctx = { ports, config }`. `graph.ts` wraps every node with debug timing via the Clock port
(quiet unless `try --verbose`/`VERBOSE=1`), so a failure names the exact node.

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
`package` is its own node so QA always runs on **what ships** (structural invariant). `repair`
re-enters at `package` (not `paint`).

## Node → implementation → port

```
planContent      planNode          ports.planner.plan          (skips if state.plan present)
resolveTheme     resolveThemeNode  ports.themeRepository.get → resolveTheme() (brief perturb)
fetchImages      fetchImagesNode   ports.imageFetcher.fetch    remote photos → data: URIs (offline)
paint            paintNode         ports.painter.paint         minimal-change on re-paint; ++iteration
package          packageNode       ports.packager.package      compile Tailwind + inline → self-contained
deterministicQA  deterministicQaNode ports.browser.render + runStructuralChecks + runRenderedChecks
visionQA         visionQaNode      ports.visionCritic.critique skipped if a hard gate already failed (D27)
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

`recursionLimit` (`recursionLimitFor`, graph.ts) is only a safety net; a `GraphRecursionError` is a
router bug (engine wraps it as `INTERNAL`). Rules are config-as-data (`src/config/routing.ts`); a
no-progress repair sets `repairIneffective` so routing escalates to re-paint (D65).

## State channels (`src/pipeline/state.ts`, last-value-wins)

```
input(const) · screenIndex · runId? · plan? · theme? · resolvedItems? · html? · packagedHtml?
screenshotBase64? · findings[] · visionCritiqued(D27) · iteration · repairIneffective(D65)
route? · routeHistory[] · best? · frozen?
best carries: score · rubricScore · penalty · passed · iterations · critiqued (D28)
```

`best` is maintained by an explicit max over the score comparator in `scoreNode` (D12) — a worse
later iteration never overwrites it; `freeze` ships `best`, `flagged` if it didn't pass (and runs one
make-good critique if the shipped candidate was never vision-critiqued — D27).

## Orchestration (`src/pipeline/engine.ts`)

`generate()`: parse → `resolvePlan` (caller `plan` else `ports.planner.plan`) → menu-lint → assert
`constraints.screens` matches board count → render each board (concurrency-capped) → parse `GenerateOutput`.
