<!-- Generated: 2026-07-11 | Files scanned: src/qa/** src/repairs/** src/config/** src/planning/** | Token estimate: ~920 -->

# QA, Gate, Scoring, Repair & Planning

## Two-tier QA (run on the packaged artifact in `deterministicQA`)

```
Structural (pure, node-html-parser)   src/qa/structural-checks.ts
  checkBindings      data-item-id / data-bind integrity vs the plan
  checkTokenLint     raw hex / off-token colors  (runs on RAW painter HTML, not packaged*)
  checkMotion        motion classes ⊆ theme vocabulary
  checkSelfContained no external refs, no baked player
  matrix-structure   src/qa/matrix-structure.ts — base-dish price-table DOM shape (D17 skeleton)
Rendered (over RenderObservation)     src/qa/rendered-checks.ts
  contrast (WCAG, src/qa/contrast.ts + colors.ts — HARD GATE) · overflow · density · images · viewport
```

*`deterministicQA` passes `rawHtml: state.html` alongside packaged `html` — compiled Tailwind CSS
legitimately contains hex, so token-lint must see the painter's raw output.

A finding carries `kind`, `source` (deterministic|vision), `severity`, `tag`, `hardGate`,
`deterministicallyFixable` (`src/qa/finding.ts`). Contrast is re-marked fixable only when a token swap
helps (scopable selector over a solid bg) — contrast over a photo routes to **re-paint**.
`src/qa/representation.ts` checks each item is shown in its planned representation.

## Gate (`src/qa/gate.ts`) — the single pass/block predicate

`decideGate(findings, blockingSeverity) → { blocking, hardGateFailures }`. Blocks when any hard gate
fails (contrast/viewport), OR a **deterministic** finding is at/above `blockingSeverity`, OR a **vision
`critical`** (D69 — the frontier critic's rare criticals are real ship-blockers). Vision `major`-and-
below stay **rubric-graded** (variance-tolerant), never hard-blocking.

## Vision pass (`visionQA`)

Cheap-VLM-era rubric now a frontier judge (`src/config/rubric.ts`): balance, hierarchy, theme
adherence, representation clarity, "intentional vs AI-generic", decoration-vs-legibility. The board-set
negative list (`config/painter.ts` `antiPatterns`) is shared with the painter. **Skipped** when a hard
gate already failed (cost split, D27). Findings appended to the deterministic set.

## Scoring (`src/qa/scoring.ts`)

`scoreScreen(findings, rubric, blockingSeverity) → { total, passed, rubricScore, penalty }`. `passed`
uses `decideGate`. `scoreNode` keeps `best` by explicit max over `total` (D12), persisting
`rubricScore`/`penalty`/`critiqued` into the report (D28).

## Repair (`src/repairs/index.ts`, route `repair`)

```
applyDeterministicRepairs(html, findings, theme)   PURE, first choice
  → token-swap contrast fixes; MUST emit var(--color-<token>), never raw hex
    (else it trips its own token-lint and re-paint discards it)
  applied? → use it ; else ports.llmRepairer?.repair(...) ; else re-paint (repairIneffective, D65)
```

## Planning (`src/planning/`) — LLM judgment + deterministic coverage

```
buildMenuDigest(items)        id-free per-category summary → LLM planner prompt
LLM → PlanLayout (contracts)  category-level: order, grouping, representation, layoutHint (NO ids)
coverage.ts expandLayoutToPlan(layout, items, screens):
  resolve categories→ids · append any forgotten category · partition (linear-partition DP balances
  boards) · assertCoverage (THROWS if any item unplaced)
layout-strategy.ts   named layout-blueprint strategies (matrix-first, photo-led-grid, …)
matrix.ts            base-dish × variant price-matrix construction
sizing.ts            over-budget sizing directive/ladder — column-aware density tiers (D26/D30/D70)
menu-lint.ts         input data-quality lint (D29): zero/missing price, overlong name/desc, dupes
```

LLM does the judgment; pure code guarantees 100% bookkeeping (can't trust an LLM to enumerate 300+
ids). Pass a hand-authored `plan` to bypass entirely (StaticPlanner).

## Config-as-data (`src/config/`, Zod-validated, deep-frozen)

`loadEngineConfig(partial)` deep-merges over defaults → **11 blocks**: `routing`, `tokenLint`,
`rubric`, `qa`, `loop`, `models`, `painter` (antiPatterns), `planning` (legibilityBudget /
minItemsPerBoard / screensMode / packedMultiplier — D26/D30/D70), `layouts` (blueprint catalog — D17),
`execution` (boardConcurrency), `menuLint` (mode / zeroPriceRender — D29). **Changing engine behaviour
usually means editing config data, not engine code.**
