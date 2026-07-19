<!-- Generated: 2026-07-12 | Files scanned: src/pipeline/** (+ composition seam) | Token estimate: ~1000 -->

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
                          repair  ◀─────────┤                                           route (conditional)
                          paint   ◀─────────┤            { repair | paint | plan | freeze }
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
paint            paintNode         ports.painter.paint         AutoPainter dispatch (D71); minimal-change re-paint; ++iteration
package          packageNode       ports.packager.package      compile Tailwind + inline → self-contained
deterministicQA  deterministicQaNode ports.browser.render + runStructuralChecks + runRenderedChecks
visionQA         visionQaNode      ports.visionCritic.critique skipped when deterministic QA gate-blocks (D27)
score            scoreNode         qa/scoring.scoreScreen + router.route + ports.debug?.capture
repair           repairNode        repairs.applyDeterministicRepairs (pure) → ports.llmRepairer? (fallback)
freeze           freezeNode        emits FrozenScreen { screen, poster, report } from `best`
```

## Composition seam (D71–D77) — graph, nodes and state are UNCHANGED

```
paint node    calls the ONE Painter port. AutoPainter (src/composition/auto-painter.ts, wired at the
              composition roots — adapters/node-engine.ts + testing/fakes) picks PER BOARD:
              theme.vocabulary registered && config.painter.mode !== "free" → compose, else free-paint.
              mode "auto" rescues a composition failure to free paint; "composition" fails loud.
PaintRequest  unchanged — no composition fields. No new EngineState channel.
marker        the renderer emits `data-composed="<vocab>@1"` on the OUTERMOST element; nodes DERIVE
              composedness via isComposedHtml(state.html) (qa/structural-checks) — never stored.
measure       BrowserPort.measure is called ONLY by the composition painter (src/composition/painter.ts),
              never by a graph node.
```

Composed-board QA trust, in-graph (both sites derive `composed` from `state.html`):
`deterministicQA` drops the **under**-fill density finding (the fitter already maximized type size —
D73); over-fill, overflow, dead-band and item-cutoff still run, and `runStructuralChecks` trusts
token-lint / matrix-structure / icon-slot internally (D73/D76). The critique request
(`buildCritiqueRequest`, shared by `visionQA` + the freeze make-good pass) omits `sizeDirective` and
appends the D74 sanctioned-title note + D73 idiom notes — the free-paint brief is byte-identical.

## Routing & termination (`src/pipeline/router.ts`, PURE, sole authority — D12)

```
route(input, routing, loop):
  iteration >= loop.maxIterations → "freeze"   # budget enforced here, before any re-entry
  passed === true                 → "freeze"   # a passing board needs no more work
  else selectRoute(findings, routing.rules) ?? "freeze"   # highest-priority matching rule
```

`recursionLimit` (`recursionLimitFor` = `maxIterations * 6 + 14`, graph.ts) is only a safety net; a
`GraphRecursionError` is a router bug (engine wraps it as `INTERNAL`). Rules are config-as-data
(`src/config/routing.ts`); a no-progress repair sets `repairIneffective`, which suppresses
repair-routing rules so the decision escalates to a re-paint (D65).

## State channels (`src/pipeline/state.ts`, last-value-wins)

```
input(const) · screenIndex · runId? · plan? · theme? · resolvedItems? · html? · packagedHtml?
screenshotBase64? · findings[] · visionCritiqued(D27) · iteration · repairIneffective(D65)
route? · routeHistory[] · best? · frozen?
best carries: html · packagedHtml · screenshotBase64 · findings · score · rubricScore · penalty
              passed · iterations · critiqued (D28)
```

`best` is maintained by an explicit max over the score comparator in `scoreNode` (D12) — a worse
later iteration never overwrites it; `freeze` ships `best`, `flagged` if it didn't pass (and runs one
make-good critique if the shipped candidate was never vision-critiqued, pinning `passed` — D27/D69).

## Orchestration (`src/pipeline/engine.ts`)

`generate()`: parse → menu-lint (D29: `reject` throws, `warn` logs + surfaces on the report) → render
policy → `resolvePlan` (caller `plan` else `ports.planner.plan`) → assert `constraints.screens` matches
the board count **only for a caller-authored plan** (a planner-produced plan is elastic) → render every
board (bounded `execution.boardConcurrency`, own thread/checkpointer/`best` each) → parse
`GenerateOutput`. Per-board **bulkhead** (D28): a terminal `PAINT`/`PACKAGING`/`RENDER`/`LLM_CONTRACT`/
`QA_BUDGET` failure becomes an error report and the rest of the fleet still ships; anything else aborts
the run.
