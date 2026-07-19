<!-- Generated: 2026-07-19 | Files scanned: src/qa/** src/repairs/** src/config/** src/planning/** | Token estimate: ~1170 -->

# QA, Gate, Scoring, Repair & Planning

## Two-tier QA (the `deterministicQA` node runs both on the PACKAGED artifact)

```
Structural (pure, node-html-parser)   src/qa/structural-checks.ts — runStructuralChecks()
  checkCapacity        plan slots vs planned items → kind "overflow-capacity"  (src/qa/representation.ts)
  checkBindings        data-item-id present+unique · required data-bind hooks (default price+name — the
                       §4 overlay-rename target) · per-size prices tagged data-size · numbers match source
  checkPricePresent    item with a source price renders a NON-EMPTY [data-bind="price"]
                       (one per data-size tag for sized items)
  checkRepresentations planned representation actually rendered (matrix/variant-rows/grid/list oracle)
  checkMatrixStructure fixed data-matrix table DOM (row×column, one price span per filled cell)
  checkImageSlots      plan's imageSlots ⇒ data-image-slot="<section title>" / "shared" (regex over ctx.html)
  checkTokenLint       raw hex/px in class arbitrary-values, inline style, <style>, svg fill/stroke
                       (runs on RAW painter HTML, not packaged*)
  checkMotion          data-motion ⊆ theme vocab; runtime motion ⇒ inlined [data-motion-runtime]
  checkSelfContained   no external src/href/srcset/url(), no <meta refresh> / location-nav script
  checkBrandBinding    brand logo requested ⇒ <img data-brand-logo> present + data-URI src
Rendered (pure over RenderObservation) src/qa/rendered-checks.ts — runRenderedChecks()
  contrast (WCAG, contrast.ts + colors.ts — HARD GATE) · legibility (item-text px floor, matrix/packed
  relaxed) · overflow (scroll overshoot + shrink plan) · item-cutoff (clipped item rects — silent clip)
  · density (under/over fill; sparse + type-led floors) · dead-band (empty row band) · images (loaded)
  · image-geometry (distortion / over-crop)
  checkViewport is a PRECONDITION: the node throws RenderError on mismatch, not a finding.
```

\*`deterministicQA` passes `rawHtml: state.html` alongside packaged `html` — compiled Tailwind CSS
legitimately contains hex.

## Composed-board trust (D73 + D76) — narrow, marker-keyed

`isComposedHtml`/`isComposedRoot` (`structural-checks.ts`): the FIRST ELEMENT child of `<body>` (or of
the parsed root when it's a fragment) carries `data-composed`. Descending into `<body>` is what makes
the marker survive the packager's `<!doctype html><html><body>…` wrapper; a marker nested deeper does
NOT grant trust.

```
SKIPPED on a data-composed root            WHY
  checkTokenLint       → []                D73  renderer emits its own CSS/px; lint targets LLM-typed markup
  checkMatrixStructure → []                D73  vocabularies render their own price layouts (dotted-leader
                                                lists, chips, tagged sizes), not the fixed matrix table
  checkImageSlots: section slots kind:"icon" only   D76.1  no v1 icon-panel component
  density UNDER-fill finding (data.kind==="under")  D76.2  fitter's register search already maximized type
                                                    — filtered post-hoc in the deterministicQA node
                                                      (rendered-checks stays pure / HTML-blind)
STILL RUNS on composed boards (the real gate)
  contrast (hard gate) · overflow · item-cutoff · dead-band · density OVER-fill · legibility
  checkBindings · checkPricePresent · checkRepresentations · checkCapacity
  checkImageSlots for PHOTO slots (section kind:"photos" AND the board-level "shared" slot)
  checkMotion · checkSelfContained · checkBrandBinding
Critic brief (buildCritiqueRequest, src/pipeline/nodes/index.ts) — composed only, else undefined →
free-paint brief byte-identical:
  – DROPS the free-paint rem-target size directive (D73); densityTier is kept (content, not instruction)
  – TITLE NOTE (D74): the masthead title is sanctioned model-authored copy; item names/prices stay data-bound
  – IDIOM NOTES (D73/D76.3): per-vocabulary idioms (e.g. masthead logo box, repeated filmstrip,
    dotted-leader or chip prices) so the critic doesn't flag the vocabulary's own render language
```

A finding carries `kind`, `source` (deterministic|vision), `severity`, `tag`, `hardGate`,
`deterministicallyFixable` (`src/qa/finding.ts`, + `serializeFindingsForPrompt`: anchored, whitelisted
`data` keys). The node re-marks contrast fixable only when a token swap helps (scopable, element-precise
selector over a solid bg) — contrast over a photo / bare item card routes to **re-paint**.

## Gate (`src/qa/gate.ts`) — the single pass/block predicate

`decideGate(findings, blockingSeverity) → { blocking, hardGateFailures }`. Blocks when any hard gate
fails (contrast/viewport), OR a **deterministic** finding is at/above `blockingSeverity` (`major`), OR a
**vision `critical`** (D69). Vision `major`-and-below stay **rubric-graded** (variance-tolerant).

## Vision pass (`visionQA`)

Frontier judge over the rubric (`src/config/rubric.ts`, 7 dimensions): balance, hierarchy,
theme-adherence, representation-clarity, intentional-design, decoration-legibility, invented-copy
(`passThreshold` 0.7; a dimension may be `blocking`). Anti-patterns (`config/painter.ts`) are shared with
the painter. **Skipped** when `decideGate` already blocks (`qa.skipVisionWhenBlocking`, D27; off ⇒ only a
hard gate skips). Findings appended to the deterministic set; `visionCritiqued` records that it ran.

## Scoring (`src/qa/scoring.ts`)

`scoreScreen(findings, rubric, blockingSeverity) → { total, passed, rubricScore, penalty, hardGateFailures }`.
`passed = !blocking && !failedBlockingDimension && rubricScore >= passThreshold`. Lexicographic total
(higher better): `-hardGate·1e9 − blocked·1e6 − penalty·1e3 + rubric01` (severity penalty
info 0/minor 1/major 3/critical 10). The `blocked` tier (D27) keeps a penalty-light blocked candidate —
its critique was skipped — from outscoring a clean one. `score` keeps `best` by explicit max (D12).

## Repair (`src/repairs/index.ts`, route `repair`)

```
applyDeterministicRepairs(html, findings, theme)   PURE, first choice; steps threaded sequentially
  1. contrast token-swap  → scoped !important <style data-repair="contrast">, MERGED + idempotent
                            MUST emit var(--color-<token>), never raw hex (else it trips token-lint)
  2. overflow shrink-to-fit (D31) → body>*{transform:scale(f)} at the finding's shrinkFactor
  byte-identical result ⇒ applied:false (honesty guard, D65)
  applied? → use it ; else ports.llmRepairer?.repair(...) ; else repairIneffective → re-paint (D65)
Routing (config/routing.ts, priority order): overflow-capacity→freeze(100) · critical-unfixable→paint(95)
  · deterministic major unfixable→paint(92) · deterministic fixable→repair(90) · any major→paint(10)
```

## Planning (`src/planning/`) — LLM judgment + deterministic coverage

```
buildMenuDigest(items)        id-free per-category summary → LLM planner prompt
LLM → PlanLayout (contracts)  category-level: order, grouping, representation, layoutHint (NO ids)
coverage.ts expandLayoutToPlan(layout, items, screens):
  resolve categories→ids · append any forgotten category · partitionContiguous (linear-partition DP
  balances boards) · assign imageSlots (kind "photos" | "icon") · assertCoverage (THROWS if unplaced)
layout-strategy.ts   blueprint selection + strategy/matrix summary text (shared by painter + critic)
matrix.ts            base-dish × variant price-matrix construction
sizing.ts            type-scale ladder + density tier (comfortable|dense|packed) — COLUMN-AWARE (D26/D30/D70)
menu-lint.ts         input data-quality lint (D29): zero/missing price, overlong name/desc, dupes
```

LLM does the judgment; pure code guarantees 100% bookkeeping (can't trust an LLM to enumerate 300+
ids). Pass a hand-authored `plan` to bypass entirely (StaticPlanner).

## Config-as-data (`src/config/`, Zod-validated, deep-frozen)

`loadEngineConfig(partial)` deep-merges over defaults → **11 blocks**: `routing`, `tokenLint`
(allowRawHex/allowRawPx/allowedPxValues), `rubric`, `qa` (viewport · contrast · density · deadBand ·
legibility · image · overflowRepair · itemCutoff · overflowTolerancePx · blockingSeverity ·
skipVisionWhenBlocking · requiredBindings (price+name) · capacities), `loop` (maxIterations 3), `models` (+ `compose`
role, structured-output allowlist), `painter` (`mode: auto|free|composition` — D71 — + antiPatterns),
`planning` (legibilityBudget / minItemsPerBoard / screensMode / packedMultiplier — D26/D30/D70),
`layouts` (blueprint catalog — D17), `execution` (boardConcurrency), `menuLint` (mode / zeroPriceRender —
D29). **Changing engine behaviour usually means editing config data, not engine code.**
