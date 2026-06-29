<!-- Generated: 2026-06-28 | Files scanned: src/qa/** src/repairs/** src/config/** src/planning/** | Token estimate: ~800 -->

# QA, Scoring, Repair & Planning

## Two-tier QA (run on the packaged artifact in `deterministicQA`)

```
Structural (pure, node-html-parser)   src/qa/structural-checks.ts
  checkBindings      data-item-id / data-bind integrity vs the plan
  checkTokenLint     raw hex / off-token colors  (runs on RAW painter HTML, not packaged*)
  checkMotion        motion classes ⊆ theme vocabulary
  checkSelfContained no external refs, no baked player
Rendered (over RenderObservation)     src/qa/rendered-checks.ts
  contrast (WCAG, src/qa/contrast.ts — HARD GATE) · overflow · density · images · viewport
```

*`deterministicQA` passes `rawHtml: state.html` alongside packaged `html` — compiled Tailwind CSS
legitimately contains hex, so token-lint must see the painter's raw output.

A finding carries `kind`, `source` (deterministic|vision), `severity`, `tag`, `hardGate`,
`deterministicallyFixable` (`src/qa/finding.ts`). Contrast is re-marked fixable only when a token
swap helps (scopable selector over a solid bg) — contrast over a photo routes to **re-paint**.

## Vision pass (`visionQA`)

Cheap-VLM rubric (`src/config/rubric.ts`): balance, hierarchy, theme adherence, representation
clarity, "intentional vs AI-generic", decoration-vs-legibility. **Skipped** when a hard gate already
failed (cost split). Findings appended to the deterministic set.

## Scoring (`src/qa/scoring.ts`)

`scoreScreen(findings, rubric, blockingSeverity) → { total, passed }`. `passed` = no finding at/above
`qa.blockingSeverity`. `scoreNode` keeps `best` by explicit max over `total` (D12).

## Repair (`src/repairs/index.ts`, route `repair`)

```
applyDeterministicRepairs(html, findings, theme)   PURE, first choice
  → token-swap contrast fixes; MUST emit var(--color-<token>), never raw hex
    (else it trips its own token-lint and re-paint discards it)
  applied? → use it ; else ports.llmRepairer?.repair(...) ; else ++iteration → router freezes
```

## Planning (`src/planning/coverage.ts`) — LLM judgment + deterministic coverage

```
buildMenuDigest(items)        id-free per-category summary → LLM planner prompt
LLM → PlanLayout (contracts)  category-level: order, grouping, representation, layoutHint (NO ids)
expandLayoutToPlan(layout, items, screens):
  resolve categories→ids · append any category the LLM forgot · partitionContiguous (linear-
  partition DP balances boards) · assertCoverage (THROWS if any item unplaced)
```

LLM does the judgment; pure code guarantees 100% bookkeeping (can't trust an LLM to enumerate 300+
ids). Pass a hand-authored `plan` to bypass entirely (StaticPlanner).

## Config-as-data (`src/config/`, Zod-validated, deep-frozen)

`loadEngineConfig(partial)` deep-merges over defaults → `{ routing, tokenLint, rubric, qa, loop,
models }`. **Changing engine behaviour usually means editing config data, not engine code.**
Routing rules (priority + match-when) and `qa.blockingSeverity` drive the loop's decisions.
