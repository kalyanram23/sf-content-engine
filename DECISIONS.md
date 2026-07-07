# Decisions Log

Assumptions made while turning the spec
(`docs/superpowers/specs/2026-06-22-display-content-generation-engine-design.md`)
into a buildable library. Each entry: the open question, the choice, and why.

The spec defines **what** (domain, behaviour, rules). This log + `ARCHITECTURE.md`
define **how**. The spec wins on behaviour.

> **D11–D16 + the amendments below were driven by an adversarial design review** (three
> independent lenses + synthesis) run before implementation. The review verified the
> load-bearing LangGraph/OpenRouter/Tailwind claims against current docs; its must-fixes
> are folded in here.

---

## D1 — LLM access goes through OpenRouter, not a single vendor SDK

**Open in spec:** §9 "Model routing — which model plans vs paints vs critiques vs
repairs." The spec names candidate models but leaves the transport open.

**Decision:** All LLM calls go through **OpenRouter** (OpenAI-compatible API) via the
`openai` SDK pointed at `https://openrouter.ai/api/v1`. The role→model mapping
(`plan`, `paint`, `critique`, `repair`, `adjudicate`) is **config-as-data**
(`ModelRouting`), validated on load. Swapping the paint model is a config edit, never a
code change. See D11 for the structured-output hardening this requires.

**Why:** Satisfies §9 and the "rules/config as data" rule. The `Painter` / `VisionCritic`
/ `LlmRepairer` ports stay vendor-agnostic — OpenRouter is one adapter.

## D2 — LangGraph is adopted, isolated behind one file; state ≠ LLM contracts

**Open in spec:** §5.7 / §9 adopt LangGraph JS (Graph API); "Graph vs Functional API"
and "which checkpointer" left open.

**Decision:** Use `@langchain/langgraph` **Graph API** with a `MemorySaver` checkpointer.
**Node logic is plain, LangGraph-free** — each node is `(ctx, state) => Promise<Partial<State>>`
over ports + domain types. One module (`pipeline/graph.ts`) adapts nodes into a
`StateGraph`. The **graph state (`EngineState`) is distinct from the strict LLM
structured-output contracts** (`PlanResponse`, `CritiqueResponse`): the state _embeds_
their inferred types but is not the same schema (a state is the whole screen-in-progress;
a contract is one LLM response, and must be a strict additionalProperties:false schema —
see D11). This corrects the spec's §5.7 "same Zod type" framing.

**Why:** Honours the spec (real `StateGraph`, checkpoints, conditional-edge routing, the
QA cycle) while keeping the domain pure and testable without LangGraph. Graph API (not
Functional) because "the routing _is_ the design" (§5.7).

**Escape hatch (scoped honestly):** `graph.ts` isolates the dependency so node logic is
portable. Replacing LangGraph is **not** a trivial hand-roll — the spec (§5.7/§10.7)
treats checkpoint/`getStateHistory` replay/`updateState` fork/streaming as core value, so
the realistic swap target is another graph runtime with equivalent checkpointing.

## D3 — Deterministic QA split: pure structural checks vs rendered observations

**Decision:** Two tiers.

- **Pure structural** (no browser, over the HTML string + plan + theme): binding
  integrity (`data-item-id` present/unique, required `data-bind` hooks exist, bound text
  matches source), token-lint, motion-vocab validity, self-containment + **no baked-in
  player** (no external URLs; no `location`/`history`/`meta refresh`/`window.open`/
  timer-driven navigation — spec §5.1). Parsed with `node-html-parser`.
- **Rendered** (behind `BrowserPort`): WCAG contrast, overflow, density, image-slot
  integrity, viewport/DPR precondition. The port returns **observations** — and the
  **checks over them are pure functions**.

**Honest scoping (review S8/S10):** overflow reduces cleanly to pure math; **contrast and
density do not reduce to pure math over DOM colours.** So `BrowserPort` returns
**sampled pixel fg/bg pairs at text bounding boxes** (canvas-sampled from the rendered
screenshot, catching text-over-image/gradient — the botanical decoration-vs-legibility
risk, §5.6) and a **numeric fill ratio** measured in-browser. The pure ratio/bounds math
runs over those observations; real-vs-fake parity for the _sampling_ is covered by the
env-gated live browser test, not the hermetic suite. `node-html-parser` is lenient, so
binding-integrity has adversarial malformed-HTML fixtures; the rendered DOM is the
spec-compliant backstop on the live path.

## D4 — Packaging is an explicit graph node; paint/repair are pure HTML producers

**Open in spec:** §5.7's node list omits a "package" node, but §5.2 requires deterministic
packaging (Tailwind→CSS, inline fonts/assets, inline the Motion runtime — D14).

**Decision:** `package` is its **own node**, sitting between every HTML-producing node
(`paint`, `repair`) and `deterministicQA`. `paint`/`repair` produce HTML only; `package`
(the `Packager` port) compiles + inlines + self-contains it. `freeze` locks the
**best-scoring** artifact and emits the `SelfContainedScreen` + `Poster` + per-screen
report. The spec's node list is illustrative ("e.g.", §5.7); promoting packaging to a
node makes "QA always runs on what ships" a **graph invariant**, not a convention, and
keeps nodes narrow/testable.

## D5 — Multi-screen: the engine renders every board in the caller-authored plan

**Decision (updated):** The **caller authors the allocation** — one `PlanScreen` per board
(which categories/items go where, and how) — and `generate()` renders **every** screen in the
plan. The graph stays single-screen (`plan → resolveTheme → paint → package → QA loop →
freeze`); `engine.ts` resolves the plan once and runs the graph **once per board** (own
`thread_id` + checkpointer, independent QA loop), then assembles N screens/posters/reports.
`constraints.screens`, when a number, must equal the plan's board count (else a structured
`UnsupportedConstraintError`); `"auto"` defers to whatever the plan/planner produced.

**Still deferred (spec §8):** _automatic content-splitting_ — i.e. an LLM/heuristic planner
that decides how many boards a menu needs and allocates items itself (`screens:"auto"` with no
plan). Today the allocation is the caller's (or the injected `Planner`'s) responsibility; the
engine only renders it. Per-board _differing_ geometry (e.g. mixing 16:9 + 9:16 in one call)
also remains out of scope — `constraints.aspect` is one global 16:9.

**Why:** keeps the engine's job "render the boards I'm told to" (spec §3/§6: the engine doesn't
decide _what/how many_, a caller does) while delivering real N-up output. Boards render
sequentially and independently, so one failing board never corrupts another.

## D6 — Heavy adapter deps are optional peers; core stays light; boundary is enforced

**Decision:** Core runtime deps: `zod`, `@langchain/langgraph`, `@langchain/core`,
`node-html-parser`, `zod-to-json-schema`. The real adapters' deps (`openai`,
`playwright-core`, `tailwindcss`, `@tailwindcss/node`) are **optional `peerDependencies`**
(+ devDeps for build/typecheck). Only `src/node.ts` + `src/adapters/**` import them. An
**eslint import-boundary rule** forbids any other `src/` file from importing those
packages or `src/adapters/**`, so `npm run verify` (core + fakes) is provably hermetic —
no browser binary, no API key. Live adapter tests are `*.live.test.ts`, excluded from the
default suite and gated behind `test:live`.

## D7 — Three public entry points

`.` (main, pure: types, boundary schemas, errors, ports, config defaults, presets,
`createEngine`), `./node` (Node-only real adapters + `createNodeEngine`), `./testing`
(deterministic fakes + fixtures). Main entry has no Node-only imports and no import-time
side effects (`"sideEffects": false`). See D16 for the trimmed surface.

## D8 — Availability/price baked as defaults in the artifact

**Open in spec:** §9 availability delivery. **Decision:** v1 **embeds default state**
(`data-available`, `data-bind="price"` from the source item); the downstream patcher
overwrites it live (§5.5). The set of required bindings is **config-driven**
(`QaConfig.requiredBindings`, default `["price"]`), not hardcoded, so adding a dynamic
field later is data, not code. **Why:** the artifact is a correct static/offline fallback
on its own (§5.1, poster as "last-ditch static fallback").

## D9 — Zod 4; the verified (langgraph, core, zod) triple

**Decision:** **Zod 4** (`zod@^4.4.3`) everywhere — domain schemas, LLM contracts, graph
state, config loaders. Zod 4 ships native `z.toJSONSchema()` (used for OpenRouter,
removing a conversion dep at the contract boundary). Verified working triple (spiked
before writing nodes — review M6): \*\*`@langchain/langgraph@1.4.5` + `@langchain/core@1.2.1`

- `zod@4.4.3`**, Node 22. A probe built a `StateGraph` over a `z.object` state with a
  conditional-edge **cycle\*\* + `MemorySaver` and confirmed `invoke` + `getStateHistory`.

**`best`-by-score without a custom reducer:** rather than register a Zod reducer (the
version-sensitive path), the `best` channel is plain last-value-wins and the **score step
computes `best = max(state.best, current)` explicitly** by the D12 comparator. Same
guarantee (a worse later iteration never destroys the best), no reducer-registry coupling.

## D10 — Tooling: tsup + vitest + eslint + prettier, one `verify`

`tsup` (ESM + `.d.ts`, multi-entry), `vitest`, `eslint` (typescript-eslint, pinned to the
stable 9.x line), `prettier`. `npm run verify` = format-check → lint → typecheck → test.

## D11 — OpenRouter structured output is hardened, never trusted blindly

**Problem (review M3, verified vs OpenRouter docs):** `response_format: json_schema` is
honoured only by some models/providers; OpenRouter may route to a provider that ignores
it and returns prose — silently breaking the "Zod at every boundary" routing guarantee,
worst for the cheap VLM critic.

**Decision — in `adapters/openrouter/client.ts`:** (1) emit a **strict** JSON Schema
(`z.toJSONSchema`, `additionalProperties:false`, `strict:true`) and lint the contract for
strict-incompatible shapes; (2) always send `provider: { require_parameters: true }` so
OpenRouter only routes to providers that honour the schema (loud 4xx, not silent prose);
(3) **validate every response against the Zod schema at the adapter boundary**, with one
bounded re-ask on mismatch, then throw a typed `LlmContractError` — never return
unvalidated data; (4) at config load, assert configured `plan`/`critique`/`repair` model
ids are on a **structured-output allowlist** and fail loudly otherwise; (5) use plain
`chat.completions` + own parse/validate, **not** the SDK's beta `.parse()` helper (it
assumes OpenAI's exact contract).

## D12 — Router owns termination; best-scoring is preserved across iterations

**Problem (review M1/M5, verified vs LangGraph docs):** `recursionLimit` _throws_
`GraphRecursionError` (counting super-steps, not QA iterations) — leaning on it for the
budget would lose the best-so-far artifact.

**Decision:** `router.route(state, config)` is the **sole** termination authority and
returns `"freeze"` the instant `state.iteration >= loopConfig.maxIterations`, before any
re-entry into paint/repair (spec §5.6 "ship best-scoring, flagged"). `scoring.ts` defines
a **total-order comparator** (weighted rubric score; any **hard-gate** failure — e.g. WCAG
contrast — sorts strictly worst). The score step keeps `best` updated every QA pass;
`freeze` reads `best`, never `current`. `recursionLimit` is set generously as a pure
safety net; a `GraphRecursionError` is surfaced as a structured engine error (it signals a
router bug). Covered by an e2e test: a never-converging fake critic yields a **flagged
best-scoring freeze**, not a throw.

## D13 — Deterministic repairs are pure-core; the Repairer port is LLM-only

**Problem (review M5):** folding "deterministic transform" and "LLM repair" into one port
forces the pure, free, fully-testable mechanical fix to masquerade as injected I/O and
hides the cost distinction the spec's routing cares about (§5.6/§6).

**Decision:** Mechanical fixes (contrast token-swap, overflow trim) are **pure functions**
in `repairs/`, driven by findings + `TokenLintRules`/theme, invoked directly by the
`repair` node (no I/O, fully unit-tested). The `LlmRepairer` **port** is reserved for
LLM-backed repairs (optional; v1's acceptance tests are satisfied by deterministic
repairs). The router/repair node prefers a deterministic fix and only escalates to the
port when none applies.

## D14 — Motion is a first-class rail with a single source of truth + offline inlining

**Problem (review S3, spec §5.2):** motion was nearly invisible; vocab risked living in
two config sources.

**Decision:** The **`MotionPreset` registry is data on the theme preset**
(`preset.motion`) — the single source of truth. The motion-vocab lint derives its
allow-list **from the resolved theme**, never a duplicate list. The `Packager` is
explicitly responsible for **inlining the Motion (motion.dev) runtime + the
`data-motion`→preset glue** into every screen (offline-safe, §5.1). A pure structural
check asserts every `data-motion` value is in vocab **and** the runtime+glue are inlined;
an offline-self-containment check asserts no external references remain.

## D15 — Determinism is scoped to the core; the graph lifecycle is per-call

**Decision (review S4/S5):** Determinism is a property of the **orchestration core given
fixed port outputs**; end-to-end determinism holds only under the fakes. The OpenRouter
adapter sets `temperature: 0`, a fixed `seed` where supported, and pins provider routing
(`provider.allow_fallbacks:false`) for best-effort reproducibility; convergence tests run
on fakes, and a separate env-gated live smoke asserts schema-validity + pass/flag (not
exact bytes). The graph is **compiled per `generate()` with a fresh `MemorySaver`** and a
**fresh `thread_id` from the injected `IdGenerator`** (never `Date.now`/`Math.random`), so
runs are isolated, stateless across calls, and replayable within a call.

## D16 — Public API is trimmed to the boundary; defaults are frozen factories

**Decision (review S12):** The main entry exports only what a consumer validates against
or wires: `generateInputSchema` / `generateOutputSchema`, the **config schemas**
`loadEngineConfig` accepts, the error classes, the port **types**, `createEngine`,
`botanicalPreset`, `InMemoryThemeRepository`. Internal schemas (plan internals, finding
shapes) are exported **types-only**. Defaults are **functions returning deeply-frozen
objects** (`defaultEngineConfig()`, `defaultRoutingRules()`) so consumers can't mutate
shared singletons. This keeps internal data shapes out of the semver contract.

## D17 — Layout is a named-blueprint catalog (config data), not a hardcoded binary

**Decision:** The painter's board layout was a hardcoded two-way branch (`isMatrixBoard` →
matrix-first vs. photo-led grid) living in the OpenRouter adapter. It is now a **catalog of
named layout blueprints as config-as-data** (`src/config/layouts.ts`, `LayoutBlueprint`),
adapted from hyperframes' "frame treatments": each blueprint is `{ id, priority, appliesWhen,
strategy, fixed[], free[] }`. Selection is a **pure function at paint time**
(`selectBlueprint`, `src/planning/layout-strategy.ts`) — the planner's strict LLM contract is
untouched (no `blueprint` field on `PlanLayout`/`thinPlan`). The two legacy branches ship as
the `matrix-first` and `photo-led-grid` seed blueprints whose strategy text is **verbatim** the
old prose (regression-pinned in `layout-strategy.test.ts`), so a board matching neither of the
new niche blueprints (`hero-split`, `feature-sidebar`, `three-up-grid`, `price-ladder`) behaves
exactly as before. Themes may override/extend the catalog by id via `themePreset.layouts`,
mirroring the D14 motion-vocab precedent. The chosen blueprint is rendered as the painter's
LAYOUT STRATEGY (with an explicit FIXED/FREE contract) **and** handed to the vision critic, so
generator and judge reason about the same layout.

**Why:** Turns "free-paint any layout" into "fill a named, vetted blueprint" — density-
appropriate recipes for sparse-hero vs. dense-table boards, and cross-board variety — while the
100% menu-coverage guarantee is untouched (blueprints are presentation, not allocation) and
`fixed` invariants are visual-only and **never count-reducing** (item coverage stays enforced by
the binding-integrity check). Adding a layout is a data edit, not an engine change.

## D18 — Brand content is a per-run input; logo resolves at the Node root, fails loud

Brand (logo + optional name/tagline) is an optional `brand` field on `GenerateInput`, not a theme
property — a venue's logo is theirs, independent of the chosen theme. Brand _colour_ is excluded:
`brief.palette` token overrides already cover it. The logo `src` accepts a `data:` URI, an
`http(s)://` URL, or a local fs path (bare or `file://`), resolved to a data-URI at the Node
composition root (`createNodeEngine`) via `resolveAssetToDataUri`, so the pure core stays hermetic.
The painter emits `<img data-brand-logo>` with no src and the packager injects the data-URI at
package time (reusing the item-photo placeholder scheme). Unlike item photos (which degrade to a
placeholder), an unreadable logo throws `BrandAssetError` — a logo the caller explicitly pointed at
that can't be read is a real misconfiguration. A `brand-binding` structural check guarantees the
logo renders and stays inlined.

## D19 — The render viewport is derived from `constraints.aspect`; `qa.viewport` is the resolution knob

**Decision:** The pipeline derives each board's render/QA/poster geometry by **orienting**
`config.qa.viewport` to the request's `constraints.aspect` (`orientViewport`, `src/config/qa.ts`):
when the configured viewport's orientation disagrees with the requested aspect, width/height are
swapped (dpr unchanged; a square viewport is left alone). Aspect — a per-request constraint — owns
**orientation**; `qa.viewport` — per-engine config — owns **resolution** (1080p vs 4K) and DPR.
Every pipeline consumer uses the derived viewport: the painter's "Target canvas" and PORTRAIT
composition guidance (`paintNode`), the browser render + the `checkViewport` hard precondition
(`deterministicQaNode`), the vision-critic canvas (`visionQaNode`), and the frozen `meta`/poster
geometry (`freezeNode`). So `meta.aspect` can never disagree with `meta.width/height`.

**Why:** Previously only `scripts/try.ts` called `viewportForAspect`; a library caller setting
`constraints.aspect: "9:16"` without also overriding `config.qa.viewport` rendered landscape while
the painter was told portrait (and the frozen `meta` claimed 9:16 at 1920×1080). Deriving at the
nodes — not at config load — keeps config parsing pure and sidesteps "was this field explicitly
set?" detection, which Zod defaults erase. `checkViewport` now takes a `ViewportConfig` (the
derived viewport) instead of the whole `QaConfig`, since orientation is per-request. The only
breaking case is a caller who set a portrait `qa.viewport` while leaving `aspect` at the `"16:9"`
default — they must now state the aspect, which `generateConstraintsSchema` always documented as
driving the render viewport.

## D20 — Comparison matrices are computed at plan time, not inferred by the painter

**Problem (verified on a real 9:16 run):** a "Biryani & Pulav" matrix of 34 items shipped as
stacked name+price cards per protein group instead of a true row×column table. The plan carried
only category names + a free-text `layoutHint`; pairing "Pachi Mirchi Chicken Biryani" ↔ "Pachi
Mirchi Chicken Pulav" across 34 names was left to the painter, and blueprint prose ("one price cell
per intersection") did not enforce it.

**Decision:** A pure module (`src/planning/matrix.ts`, `buildMatrix`) computes the pairing at plan
time and attaches a `SectionMatrix` (`{ columns, rows: [{ label, cells: (id|null)[] }] }`, a domain
value object — **not** an LLM contract) to the section in `expandLayoutToPlan`. Row keys are derived
by normalising each name (strip a trailing `*`, drop punctuation, remove the item's own category
tokens); items across columns sharing a base share a row; a null cell renders as an em-dash. Two
same-category items normalising to the same base never merge (separate, disambiguated rows), and an
item-per-cell invariant is asserted (`MatrixCoverageError`) — mirroring the coverage guarantee.

**thinPlan strict-contract check (asked in the build brief):** `contracts.ts` aliases
`planResponseSchema = thinPlanSchema`, but **that alias is never sent through `toStrictJsonSchema`** —
only `planLayoutSchema`/`critiqueResponseSchema`/`repairResponseSchema` reach the strict-mode
converter (the planner returns the id-free `PlanLayout`, not a `thinPlan`). So the new optional
`matrix` field — which contains a `string | null` union that strict mode couldn't express — is safe:
`thinPlan` is validated only with `.safeParse`, where an optional field is a non-issue. Documented so
a future change that _does_ strict-convert `thinPlan` knows to exclude `matrix`.

## D21 — Blueprints carry an optional DOM skeleton; the painter renders a fixed structure

**Decision:** `layoutBlueprint` gains an optional `skeleton` (config data, not an LLM contract). The
`matrix-first` blueprint ships a theme-agnostic HTML skeleton fixing the `data-*` shape a comparison
table must have — `data-matrix` container, `data-matrix-row="<label>"`, `data-matrix-cell="<column>"`,
a filled cell carrying `data-item-id`/`data-available` + exactly one `<span data-bind="price">`, a
null cell an em-dash with none. The painter prompt renders the computed matrix explicitly (columns +
each row as `label | col: $price (id) | …`) plus the skeleton with "the DOM shape is FIXED, styling
is yours"; the same matrix summary is appended to the vision critic's layout strategy (the "two
consumers, same text" principle). Structure only — no sizes/colours — so token-lint and the theme's
Tailwind classes stay the painter's job. The `FakePainter` emits matching skeleton markup so the e2e
suite exercises the real structural check.

## D22 — Screen count is elastic; one budget drives fit arithmetic and AUTO

**Problem:** the planner packed 34–45 items per board against a hardcoded `LEGIBILITY_BUDGET = 24`
while `screens` was fixed at the requested value, so content overflowed by 648px and the paint loop
could not fix an impossible budget. A contradictory `AUTO_ITEMS_PER_SCREEN = 40` lived in the planner.

**Decision:** `legibilityBudget` (24) and `minItemsPerBoard` (4) move to `config.planning`
(rules-as-data); AUTO and the fit arithmetic both derive from `legibilityBudget`. In
`expandLayoutToPlan` the requested `screens` becomes a **hint**: the board count RAISES to the
arithmetic minimum `ceil(totalWeight / budget)` when content can't fit, and LOWERS toward that
minimum when the request would leave boards below `minItemsPerBoard` (never below 1) — every
adjustment logged with its numbers. A matrix section weighs its **rows** (paired items share a line),
and a matrix taller than one board's budget splits by whole rows. A pure sizing helper
(`src/planning/sizing.ts`) maps a board's row count + canvas to a type-scale directive (or "doesn't
fit → split"); the planner tightens the budget to the canvas via `maxRowsForCanvas`, and the paint
node passes the directive to both painter and critic. The engine's `constraints.screens`-must-match
guard now applies **only to caller-authored plans** (D5) — a planner-produced count is authoritative.
100% coverage stays asserted.

## D23 — Image geometry is a deterministic QA check, not just "did it load?"

**Decision:** the rendered `ImageObservation` gains `naturalHeight`/`renderedWidth`/`renderedHeight`/
`objectFit` (optional — older observations/fakes skip the check). A new pure rendered check emits
`image-distortion` (an `object-fit:fill|none` image whose rendered aspect deviates from natural
beyond `distortionTolerance`) and `image-crop` (an `object-fit:cover` image whose container:natural
aspect factor exceeds `maxCropFactor`, default 2.2 — a ~4:3 photo in a >3.5:1 band trips it).
Thresholds are Zod config (`qa.image`). The matrix-first blueprint prose also pins hero bands to
roughly a 2:1 max aspect so paints stop producing 3.5:1 slices.

## D24 — Under-fill density is representation-aware; over-fill stays universal

**Decision:** the `checkDensity` under-fill floor (`fillRatio < 0.4 → major`) becomes per-
representation config: a board carrying a computed `matrix`, or dominated by TYPE-LED representations
(`density.typeLedRepresentations`, default `matrix`/`list`), is held to the lower
`density.typeLedMinFill` (default 0.2) — a price table legitimately breathes, and shouldn't burn the
iteration budget failing a floor calibrated for photo grids. The lowest applicable floor wins (a
sparse type-led board gets the most slack). The over-fill bound (`> maxFill`) stays universal. Pure
config-data change interpreted by the evaluator — no engine-code branch.

## D25 — Categories are atomic: a category NEVER spans two screens

**Problem (verified on a real 9:16 blockframe run):** a 26-row "Biryani & Pulav" combined matrix
exceeded the ~24-row legibility budget, so `splitOversizedMatrices` split it into "(1)"/"(2)"
sections — and the packer then placed BOTH halves on the SAME screen: two header bands, two column-
header rows, zero benefit. Splitting a category across screens also reads wrong on a wall of boards
(guests scan by category).

**Decision (reverses part of D22):** a category (draft section) is **atomic** — it never splits
across screens, period. Multiple categories may share a screen; one category never spans two.
`splitOversizedMatrices`, `splitDraft`/`matrixDraft` (the "(n)" title-suffix machinery), and
`ensureAtLeast` (which split the largest sections when boards outnumbered sections) are **deleted**
from `planning/coverage.ts`, along with `splitMatrixRows` in `planning/matrix.ts` (its only caller).
Consequence: the board count is **capped at the number of draft sections** in every mode (logged when
that lowers the requested/hinted count). An oversized category is the **caller's data problem**: it
renders dense on ONE screen — the residual dense-board warning plus the over-budget sizing regime
(D26) are the intended signal — never split, never silently overflowed (the rendered overflow check
still hard-fails physical overflow).

## D26 — Screen count has an "exact" mode; the legibility budget demotes to a layout advisor

**Problem (same run):** the requested 6 screens were silently raised to 10 by `elasticBoards`;
screen-1 still carried 26 rows while the sizing directive said "26 rows → text-2xl/3xl, FILL the
height, never shrink" and the density check majored on "over-crammed (96% > 90%)" — jointly
impossible, so the board burned all 3 iterations and shipped `passed=false`.

**Decision (amends D22):** `config.planning.screensMode: "exact" | "elastic"` (default `"elastic"`
for public-API back-compat; `scripts/try.ts` defaults to `"exact"` — a dev asking for 6 means 6).
In **exact** mode `expandLayoutToPlan` skips the elastic raising AND lowering: boards = the requested
count, capped only by the section count (D25 atomicity — asking for more screens than categories
lowers to that max with a warning). Elastic mode keeps the D22 raise/lower behaviour minus the
deleted splitting. The legibility budget is now a **layout advisor**, not a splitter: when a board's
rows exceed the comfortable budget for the canvas, `computeTypeScale` enters an **over-budget
regime** — it prescribes a TWO-COLUMN name+price layout (the portrait painter contract already
permits two narrow columns; the directive now actively directs it) with per-row height math over
`ceil(rows/2)`, stepping type down only to the engine floors (names ≥ text-lg preferred, absolute
floor text-base) — and the density evaluator is graded against the SAME sizing output: a plan-forced
over-budget board's over-fill finding is `density.planForcedOverFillSeverity` (default `minor` —
pass with a warning-level note), never an unfixable major. Painter and critic still receive the
identical directive text.

## D27 — Skip the vision critique when deterministic QA already gate-blocks; blocked candidates sort below non-blocked in `best`

**Problem:** `visionQaNode` skipped the paid, image-carrying critique only on a hard gate
(`findings.some((f) => f.hardGate)`). But `decideGate` (qa/gate.ts) proves a candidate with ANY
deterministic finding at/above `qa.blockingSeverity` (default `major`: overflow, density, missing
bindings, token-lint, matrix-structure) can never pass this iteration, and that same blocking
finding already selects the repair/re-paint route via the §5.6 routing rules — so the critique's
verdict cannot change the outcome. On every such iteration the critique was pure spend (~1.1k image
tokens + up to ~2MB payload + output) buying nothing.

**Decision (amends the spec §5.6 skip condition):** `visionQaNode` skips whenever
`decideGate(findings, qa.blockingSeverity).blocking` is true — this **subsumes** the old hard-gate
check (a hard-gate failure always makes `decideGate` block). `config.qa.skipVisionWhenBlocking`
(default `true`) gates the new behaviour; set `false` to restore the legacy hard-gate-only skip and
get critic feedback on blocked iterations.

**Safety companion (amends the D12 comparator):** a skipped critique means no vision findings, so a
gate-blocked candidate is penalty-LIGHT and could out-score a genuinely better critiqued one,
corrupting `best`. The scoring comparator (`qa/scoring.ts`) gains a dedicated **blocked** tier
between the hard-gate term and the raw penalty — a lexicographic `(hardGate, blocked, penalty,
rubric)` order (`HARD_GATE_WEIGHT` ≫ `BLOCKED_WEIGHT` ≫ `PENALTY_WEIGHT` ≫ rubric) — so **any**
gate-blocked candidate sorts strictly below **every** non-blocked one, while blocked-vs-blocked and
clean-vs-clean orderings (penalty then rubric) are preserved. The D12 property holds: `best` is an
explicit max over this comparator, so a worse later iteration never overwrites it.

## D28 — Per-board bulkhead: one bad board never sinks the fleet; reports carry the readable score + structured usage

**Problem (verified on a live eval run):** 4 of 15 boards crashed terminally (empty painter
output). Our own dev/eval scripts survived only because they call `generate()` once per board —
the public API doesn't: with a multi-screen plan, one board's terminal failure aborted the whole
call and the caller lost every finished board. Separately, `QaScreenReport.score` persisted only
the internal comparator total (a huge encoded negative), not the human-meaningful 0..1 rubric
fraction, and per-call token usage existed only as unstructured `logger.debug("usage …")` strings.

**Decision:** `generate()` renders each board in an isolated worker; a _terminal per-board_
failure (`PAINT`/`PACKAGING`/`RENDER`/`LLM_CONTRACT`/`QA_BUDGET`, i.e. after adapter retries and
fallbacks are spent, D32) is **contained**: the failed board gets a `QaScreenReport` carrying a
structured `error: { code, message }` + `passed:false` and no screen/poster, while every other
board completes and ships. `qaReport.screens` is the authoritative per-board record keyed by
`screenId`; `screens[]`/`posters[]` hold only successful boards; `passedAll` is false if any board
errored. Run-level and invariant failures (input validation, `THEME_NOT_FOUND`, `CONFIG`,
`MATRIX_COVERAGE`, the `INTERNAL` router-termination net) still throw and abort the whole call.
`QaScreenReport` additionally persists `rubricScore` (0..1) and `penalty` (already computed by the
score node, previously dropped at freeze), and an optional ambient `UsageSink { record(event) }`
port emits structured per-call token usage (`role`, actual `model`, prompt/completion/total,
optional cached/reasoning, `attempt`, `fallback`) — injected like `DebugSink`, composed alongside
(not instead of) the existing debug log line, off by default, never affects output (D15).

## D29 — Input-side menu lint; zero/missing prices are hidden, not shipped as $0.00

**Problem (verified on a live eval run):** an independent vision judge flagged a shipped board
showing `$0.00`. Root cause: the source menu genuinely carries items with 0/missing prices and the
engine renders input verbatim — no input-data sanity layer existed, so garbage-in became
garbage-on-a-TV.

**Decision:** a pure core module (`src/planning/menu-lint.ts`, `runMenuLint`) inspects
`CanonicalItem[]` and emits stable-kind findings (`price-missing`, `price-zero`, `name-overlong`,
`description-overlong`, `duplicate-name`). A config block (`config.menuLint`) carries two
orthogonal knobs: `mode` (`warn` default → log + surface on `qaReport.menuLint`, proceed |
`reject` → `ValidationError` | `off`) and `zeroPriceRender` (`hide` default | `verbatim`). Lint
runs once at the `generate()`/`plan()` boundary before planning. The hide leverage point:
`applyMenuRenderPolicy` strips zero/missing prices from the menu that flows into paint AND QA, so
the item renders without a price element and the required-`price` binding check exempts it
(`expectedPrices() === []`) — paint and QA never fight the policy. The plan is still built from
the original items, so `plan()` and `generate()` stay identical. Matrix-cell zero prices remain a
documented residual (the matrix skeleton requires a price span per filled cell).

## D30 — Board density is a deterministic tier that switches the design idiom and the judging register

**Problem (verified on a live 241-item / 6-board exact-screens run):** boards carried 31–56 items
against the ~20-row comfort budget. `expandLayoutToPlan` computed and _logged_ the over-budget
warning, but nothing downstream consumed it: the painter attempted boutique hero layouts with 40+
items, and the critic then failed those boards on theme-adherence/intentional-design (rubric
0.36–0.55) — judging a forced-dense board against boutique whitespace. An independent judge
shipped 3 of the 6: the density was acceptable; the engine designed and judged it wrong. Product
decision: forced density IS the job (300 items / 5 screens must work) — dense boards need a dense
idiom and fair judging, not fewer items.

**Decision:** `expandLayoutToPlan` stamps each screen with a deterministic `densityTier`
(`comfortable` ≤ budget, `dense` ≤ `packedMultiplier`×budget, `packed` beyond; multiplier is
`planning` config, default 2) computed from the board's rows vs the same per-canvas legibility
budget the fit arithmetic uses. The tier is an OPTIONAL `thinPlan` field (never an LLM contract —
only `planLayout` is strict-converted, mirroring `matrix`, D20); hand-authored plans without it
recompute it identically (`densityTierFor`). Three consumers key off the one classification: the
**painter** injects a theme-agnostic compact price-list register for dense/packed (suppress
heroes/whitespace, headers as structure, multi-column name+price rows, truncate→drop descriptions,
thumbnail-only→no photos) layered on top of the selected blueprint (deliberately NOT a new
blueprint — the tier is canvas-relative and cross-cutting, not a count-selected layout); the
**vision critic** is told to judge a dense/packed board as a well-executed dense board; and **QA**
relaxes the item legibility floor to the matrix floor for `packed` boards only. The over-fill
demotion (D24/D26) already covers both over-budget tiers via `sizing.overBudget`.

## D31 — Overflow has a deterministic shrink-to-fit repair; only a legible fit qualifies

**Problem (verified on a live eval run):** 3 of 5 independent-judge rejections were content cut
off at a board edge. The engine's `overflow` check _detected_ every one, but the finding routed to
LLM re-paint, which reliably re-overflowed — boards exhausted their iterations and shipped with
the overflow still present. Contrast already proved the better pattern: a pure deterministic
repair applied without burning a paint iteration (D13 anticipated an "overflow trim").

**Decision:** `checkOverflow` computes a uniform shrink factor
`f = floor(min(clientW/scrollW, clientH/scrollH)·1000)/1000` and marks the finding
`deterministicallyFixable` only when the fit stays LEGIBLE: `f` must remain at/above every
item-bound sample's legibility floor (`minLegibleFactor = max(floor_i / fontPx_i)`; matrix/packed
items use the relaxed 12px floor, mirroring `checkLegibility`) and above a hard
`qa.overflowRepair.minShrinkFactor` (default 0.5 — a more aggressive fit signals a real allocation
problem better fixed by re-paint/re-plan). The pure repair (`applyOverflowRepair`,
`src/repairs/`) injects one scoped, idempotent block —
`<style data-repair="fit">body>*{transform:scale(f);transform-origin:top left;}</style>` —
replaced, never stacked, so it cannot compound. `transform: scale` is geometric (the transformed
box counts in scroll size, so the overflow measurably clears), aspect-preserving, and token-lint
clean (unitless factor, keyword origin). No new routing mechanism: the fixable mark makes the
existing `mechanical-fix-to-repair` rule (priority 90) prefer the deterministic repair over
re-paint automatically; `repair → package` re-QAs on what ships and the router's budget still
bounds the loop.

## D32 — LLM calls are unreliable infrastructure: one retry authority, per-role budgets, config fallback models; `adjudicate` retired

**Problem (verified on a live eval run):** a single empty completion from the paint model — a
failure mode the model config even documented — aborted the whole board (4 of 15 boards died this
way), and one planner call returned invalid JSON, equally fatal. Separately, paint calls were
observed running 5–11+ minutes despite `requestTimeoutMs: 300000`: the OpenAI SDK's `timeout` is
per-attempt and its default `maxRetries` is 2, so a stalled call silently stacked up to 3× the
configured timeout — multiplied again by our own transient-error retry loop.

**Decision:** the OpenRouter client is constructed with `maxRetries: 0`, making the config-driven
resilience loop the SOLE retry authority; each HTTP attempt respects `models.requestTimeoutMs`
exactly and worst-case wall-clock is a legible `attempts × timeout`. New config
(`models.resilience` / `models.fallback`): an empty completion or contract-invalid response is
retried within a per-role `maxAttempts` budget (paint 3, others 2), and each role may declare an
optional fallback model tried only after the primary exhausts its budget (paint defaults to
`anthropic/claude-sonnet-4.6`). Structured-role fallbacks are validated against
`structuredOutputAllowlist` at config load exactly like primaries (D11); non-transient errors
(4xx) still propagate immediately. The unused `adjudicate` role is removed from the role enum,
routing defaults, and reasoning config (product decision — no in-engine second-opinion judge;
independent judging lives in the eval harness, offline).

## D33 — Sparse boards get a scale-up register + a category-anchored image slot; dead space is designed out in the prompt, not caught by QA

**Problem (visual audit of live eval boards):** even PASSING boards wasted screen real estate — a
5-item board reserved a ~300px empty "hero zone" above the item names (content crammed into the
card's bottom half); a portrait 9:16 board finished all 15 items at 45% of the canvas height with a
blank lower half; a 3-item board passed QA with its bottom quarter dead; an all-text board filled
the canvas but every card was ~50% internal whitespace (sized for a description/photo that wasn't
there). D30's dense register packs beautifully — the failure mode is the comfortable/sparse end. An
independent judge rejected several boards for exactly this.

**Decision (mirror of D30 at the comfortable end, all prevention-side — a QA-caught issue burns a
re-paint, a better prompt is free):**

- **Painter — SPACE & SCALE directive:** a `comfortable`-tier board is injected a theme-agnostic
  sparse register (structure/register only; colours/type from the theme): scale content UP to fill
  the canvas, NO empty hero zones (never a vertical empty band above an item's name inside a card),
  cards HUG their content (a name+price-only item gets a compact card, never a tall box sized for
  an absent photo/description), tight line-gap discipline, and — when spare canvas + photos exist —
  absorb the space with a category photo panel. Only `comfortable` boards get it (`dense`/`packed`
  keep the D30 idiom).
- **Fixed contract — image-slot anchoring:** every image slot / photo hero MUST render as PART OF a
  section (inside or flush against it, sharing its frame/header, captioned with the category name —
  e.g. "MANDI — from our kitchen"), never a free-floating hero belonging to no category. The
  per-request slot line threads the resolved category NAME (the slot's `categoryId` — a category
  name in this engine — else the shared item category, else the owning section title) so the
  painter can caption it.
- **Deterministic slot guarantee (`expandLayoutToPlan`):** when a board is `comfortable` with clear
  spare canvas (rows ≤ half the per-canvas budget) and any items carry photos, and the matrix
  synthesis didn't already supply a hero, a category-anchored `imageSlot` is populated (photo items
  - the dominant category's name) — so a sparse board always HAS a photo to fill the void with.
    Conservative: never on dense/packed (they suppress photos, D30), never on matrix boards (their
    shared-hero rule owns those), never overriding an existing slot; fires for a single photo too.
- **Portrait fill:** a 9:16 board is additionally told to compose top-to-bottom filling the FULL
  height — the last section finishes near the bottom, never a blank lower half.
- **Rubric wording:** `balance` and `intentional-design` now name dead space explicitly (large
  contiguous empty regions, an empty band/hero zone inside a card, a bottom half left blank,
  content marooned in a void, a card sized for an absent photo) so the existing critique scores it
  — no new dimension, no weight/threshold change (the critique call already happens, so the wording
  is free).

**Why:** the sparse register + guaranteed slot are the exact inverse of D30 for the same single
density classification, so the whole spectrum (packed → comfortable) now has a fair idiom and no
dead zones. Prevention over correction keeps token cost flat: rubric wording is free, the plan-time
slot is pure deterministic code, and the directives cost only prompt bytes on boards that already
paint.

## D34 — A truncated completion is a failed attempt, not a result

**Problem (eval run 3, tiny-menu):** a paint call hit the 32k `max_tokens` cap exactly — 30,330 of
those tokens were reasoning (glm-5.2 treats `reasoning: { effort: "low" }` as a suggestion, and no
OpenRouter knob hard-caps its thinking) — so the returned HTML was a truncated stub. The D32
resilience loop only retried EMPTY bodies, so the stub sailed through as a "success": zero retries,
zero fallback, and a blank board shipped (all 5 items missing, judge: "blank purple background").

**Decision:** the free-text request path treats `finish_reason: "length"` exactly like an empty
body — the attempt is recorded as `truncated` and retried within the same D32 attempt/fallback
budget (a fresh sample rarely runs away twice; the paint fallback is a different model entirely).
On full exhaustion the last body is still returned so downstream QA/routing own the outcome. The
structured path needs nothing: truncated JSON already fails schema validation and retries. This is
model-agnostic — any future reasoning-heavy model gets the same protection.

## D35 — A critical unfixable finding outranks mechanical repair in routing

**Problem (same board):** routeHistory `repair → repair → freeze`. The stub board carried 5×
`binding-missing` (critical, not deterministically fixable) AND one fixable overflow; the
`mechanical-fix-to-repair` rule (priority 90) beat `actionable-to-repaint` (priority 10), so the
whole iteration budget was spent polishing cosmetics on a content-broken board that needed a
re-paint from iteration one.

**Decision:** new default routing rule `critical-unfixable-to-repaint` at priority 95 (below
capacity→freeze at 100, above mechanical→repair at 90): any finding that is `critical` and NOT
deterministically fixable routes to `paint`. Repair-first still holds for boards whose only
problems are mechanical. Pure config data — the rules-as-data mechanism doing its job.

## D36 — QA captures the SETTLED frame: all animations are finished before observation + screenshot

**Problem (eval run 3, portrait boards):** the painter authored a raw CSS entrance animation
(`fadeIn` from `opacity: 0`) on the whole-board wrapper. Playwright's `reducedMotion: "reduce"`
only flips the media query — it guards the engine's own motion runtime but not painter-authored
keyframes — and the screenshot fired ~60ms after load, capturing the ENTIRE board at ~10% opacity.
Consequence: the deterministic contrast check (computed styles — correct colours) passed while the
vision critic and the offline judge (pixels — a washed beige ghost) rejected, i.e. two QA tiers
graded different boards, and critic/judge calibration data was contaminated.

**Decision:** the browser adapter renders, waits for fonts + image decode, then jumps every
animation to its end state (`document.getAnimations().forEach(a => a.finish())`, skipping
infinite-duration ones) BEFORE collecting the observation and the screenshot — and the observation
now happens after those waits, not before. Rationale: the TV plays the entrance once and then shows
the steady state forever; the settled frame is the only honest QA target. This kills the whole
class (mid-fade captures, washed posters, ghost-frame critiques) without policing how a theme or
painter chooses to animate.

## D37 — Photo truth + card/row discipline are universal painter-contract lines

**Problem (eval run 3):** an item without a photo got a photo-shaped card with a hand-drawn SVG
star filling the image hole (judge: "unfinished"); a portrait board absorbed leftover canvas by
inflating cards into hollow boxes (name at top, price marooned at the bottom, ~350px of empty
interior). Both were prompt-contract gaps: the D33 "cards hug their content" / line-gap rules only
fired on `comfortable`-tier boards, and nothing said a photo-less item must not LOOK like a photo
card.

**Decision (prevention over correction, per D33's rationale):** two lines added to the FIXED
painter contract, every board, every tier: **PHOTO TRUTH** — an item without a photo gets a
text-only treatment, never an image-shaped region/placeholder/icon standing in where a photo would
go; mixed sections compose real photo cards and compact text cards side by side. **CARD & ROW
DISCIPLINE** — every card hugs its actual content in every density register, and a name and its
price must read as one connected unit (leader, rule, or adjacency), never a bare justify-between
chasm. The tier-specific D30/D33 registers stay as-is; these two truths are register-independent.

## D38 — Every category gets a visual anchor; density picks the form (product decision)

**Requirement (Kal, 2026-07-05):** every menu category on a board must carry a picture — and when
none of its items have photos, an explicit food-icon panel is fine. On dense boards a shared slot
is fine: "1 or 2 image slots with sliding images of all items where we have images."

**Decision (synthesized in pure plan-expansion code — the LLM planner still never emits slots, D2):**

- **comfortable, non-matrix board:** every section gets its OWN `imageSlot` — `kind:"photos"` with
  up to 4 of that category's photo-item ids (plan order), else `kind:"icon"` (a deliberate themed
  food icon/illustration panel captioned with the category name — never a missing-photo look).
  This SUPERSEDES D33's screen-level `comfortableImageSlot` synthesis (one mechanism, not two).
- **dense/packed, non-matrix board:** ONE board-level shared slot carrying up to 8 photo-item ids
  drawn across the board (a compact gallery-fade carousel band, ≲15–20% of the canvas so items
  keep priority — forced density stays the job); no slot at all when the board has zero photo
  items. No per-section slots.
- **matrix board:** the existing shared rotating hero (`synthesizeImageSlot`) is already the
  anchor; untouched.
- **Verifiability:** every slot container carries `data-image-slot="<section title>"` (shared
  slot: `"shared"`), so the requirement is deterministically checkable — a new eval grader
  (`gradeCategoryImages`) enforces it per board (comfortable: every section anchored; dense/
  packed/matrix: ≥1 shared slot required when the board has any photo items).
- **Photo truth composition (D37 refined):** PHOTO TRUTH is scoped to per-ITEM cards (an item
  without a photo never gets a fake image region); a category-level icon panel is a sanctioned,
  explicit design element, not a fake photo. On the live path, a per-section "photos" slot whose
  photos ALL fail to resolve demotes to `kind:"icon"` — the anchor guarantee survives fetch
  failures instead of shipping a broken-image hole.

**Why this shape:** slots are plan data synthesized deterministically (never trusted to the LLM),
the painter is told exactly what to draw per section, and the marker attribute turns a visual
product rule into a code-gradeable invariant — prevention and verification, no new QA loop cost.

## D39 — Overflow repair: clamp the page to the viewport so the metric sees the shrink; only shrink for small trims

**Problem (run 4, reproduced):** the shrink-to-fit repair uses `transform: scale`, which changes
paint but not layout. The overflow check measures `documentElement.scrollHeight` — driven by the
UNtransformed layout height of the painter's in-flow root — so after a repair the board visually
fit while the metric read byte-identical numbers: the same overflow(major) re-fired, the repaired
candidate never strictly beat `best`, and all three failing boards shipped with NO repair block at
all (routeHistory said repair; the shipped HTML disagreed). Separately, where a scale did apply,
`transform-origin: top left` left a `(1−f)×width` dead band on the right (~240px at f=0.878) —
an off-center, unfinished-looking board.

**Decision:** the injected block becomes `html,body{height:100%;overflow:hidden;}` +
`body>*{transform:scale(f);transform-origin:top center;}` — the clamp makes scrollHeight reflect
the transformed box (repro-verified: overshoot 0 at the exact reported factors on all three run-4
failures), and top-center splits the residual side band into symmetric margins. And the repair is
now scoped to SMALL trims only: `qa.overflowRepair.minShrinkFactor` default 0.5 → **0.9** — below
that a board needs a different layout, not a 10%+ smaller copy of the same one, so the finding
stays unfixable and routing escalates to re-paint.

## D40 — A matrix must earn its keep: degenerate matrices are never attached to the plan

**Problem (run 4, reproduced):** plan expansion attached computed matrix data to EVERY
multi-category block, even when the planner chose list/grid and even when the matrix was fully
degenerate (every row fills exactly ONE column — zero cross-category pairings; worst case demanded
215 em-dash cells). The painter is only given the matrix skeleton directive when the blueprint
applies, so it correctly rendered lists — then the matrix-structure check fired "no data-matrix
table" against plan data that should never have existed. ALL 9 matrix-structure findings in run 4
were this misfire (the two genuine matrix sections rendered perfectly, zero findings). Where a
degenerate matrix DID render, it produced dash-graveyard columns wasting a third of the table —
and on one portrait board the dashes' vertical cost pushed the last row off-canvas.

**Decision:** matrix data is attached only when `representation === "matrix"` or the computed
matrix is genuinely cross-paired (a meaningful fraction of rows price in ≥2 columns). Degenerate
multi-category blocks stay plain lists/grids — no matrix, no matrix QA expectation, no dash
columns. Also added under the same wave: a **price-present structural check** (product rule:
an item whose data carries a price must render a non-empty price inside its bound element;
em-dashes for sizes an item genuinely lacks stay legitimate).

## D41 — The shipped candidate always carries one vision critique (freeze-path critique; D27 refined)

**Problem (run 4):** D27's vision-skip (skip the critic when deterministic findings already block)
is sound per-iteration but wrong for the run: freeze ships `best`, which may never have been
critiqued. 10/15 boards shipped with zero vision findings and a vacuous rubric of exactly 1.00 —
7 of those 10 were judge-REJECTED, every rejection a design defect the critic grades (dead space,
stretched rows, cutoffs). All 5 critiqued boards were judge-approved. The reports were actively
misleading (perfect design score on never-reviewed boards).

**Decision:** the freeze node runs ONE vision critique on the shipped candidate when its findings
carry no vision source, merges the findings, and rescores — so every shipped report is honest.
Routing/`passed` are unaffected (the loop is over); a critic failure degrades to prior behavior.
Cost: at most one critique per board, only for boards that would otherwise ship unreviewed.
This also un-poisons the critic-vs-judge calibration data (deferred since D36) for a later pass.

## D42 — Enforce the per-call timeout for real; paint reasoning off by default

**Problem (run-4 Braintrust traces):** 23/55 calls exceeded the configured 300s requestTimeoutMs —
7 paint calls ran 600–1154s as SINGLE attempts, so the documented "no call outlives the cap"
guarantee (D32) was not actually binding. And with `reasoning.effort: "low"`, glm-5.2 still spent
541,825 reasoning tokens = 70% of ALL paint completion tokens; 10 calls hit the 32k cap exactly;
retry+fallback traffic was ~48% of run spend. The effort lever demonstrably does not curb GLM.

**Decision:** (a) fix the adapter so every attempt is genuinely bounded by `requestTimeoutMs` and
a timeout is a transient failure inside the resilience loop (retry/fallback), not a run-killer;
(b) config default `reasoning.paint: { enabled: false }` — the only lever GLM honors. Quality
impact is measured by the eval suite; reverting is one config line. Expected: markedly cheaper +
faster paints and far fewer cap-truncations.

## D43 — Painter contract: vertical rhythm, no window chrome, marker legends, leaders on wrapped rows

**Problem (run-4 visual audit):** rows/cells stretched to fill vertical space (100–140px voids
between every row on a portrait board; grid cells inflated far beyond their content); two boards
drew a dialog-style "X" close glyph in the header; markers ("\*", "★") shipped with no legend;
rows with wrapped names dropped their dot leaders, leaving prices unanchored.

**Decision (prevention-side, four surgical contract lines):** vertical gap between consecutive
rows ≤ ~1.5× the row's text height and cells never stretch beyond content — surplus space goes to
larger type, BETWEEN-section spacing, or the image slot, never inside rows/cells; signage never
renders window/UI chrome; no marker without an on-board legend; one list = one name↔price
connection treatment, including multi-line names. Deferred, noted for a later calibration pass:
the critic's brief-adherence harshness (run 4 scored the visually best board 0.55 for missing
theme motifs while clipped boards read 1.00 — re-examine once D41's honest rubrics accumulate).

### D43 amendment — the stretching was self-inflicted: ENGINE_DESIGN_GOALS commanded it

While adding the VERTICAL RHYTHM line, the implementer flagged that the engine-invariant DESIGN
GOALS block itself ordered the defect: "use a grid whose rows STRETCH so cards reach near the
bottom edge" and "Within a stretched card, vertically centre the item's name + price block." The
run-4 boards show the painter OBEYING those lines — stretched momo cells with a centred name+price
floating in white space, 100–140px voids between every portrait row, hollow drink cards. D33/D37/
D43 were countermeasures fighting the engine's own instruction. Fixed at the source: FILL THE
SCREEN keeps the goal but changes the MEANS (large type, content-hugging cards, spacing BETWEEN
sections, the section's image slot — rows/cells sized to content, never 1fr-stretched/flex-grown
to reach the bottom), and the stretched-card centring line is deleted outright. A test now asserts
the old wording is GONE from the system prompt so it cannot silently return.

## D44 — Fill is arithmetic, not aspiration: layout-aware type scale + a deterministic dead-band check

**Problem (smoke run after D43):** with the stretch crutch removed, voids moved to honest places —
a portrait board's bottom 45% shipped plain empty. Mechanism: the TYPE SCALE directive prescribed
sizes from a SINGLE-column assumption; the painter chose TWO columns, needing half the height at
that size, and nothing deterministic measured the void (global fill-ratio passed because the top
half was rich; only the critic complained, and re-paints repeated the layout).

**Decision:** (a) the comfortable-tier TYPE SCALE directive now hands the painter the fill
arithmetic for the layouts it may choose — single column at rung X; two columns means HALF the
height, so go UP to the rung computed for ceil(rows/2) rows AND/OR give the hero/image slot the
reclaimed height (≤ ~40% of canvas); whatever the choice, content + slots must span the body.
(b) A new deterministic `dead-band` rendered check reuses the existing fill-sampling grid to find
the largest contiguous fully-empty horizontal band (first/last grid rows exempt as margins);
above `qa.deadBand.maxBandRatio` (default 0.18) it emits a major layout finding with the exact
pixel region, so a re-paint gets anchored coordinates instead of critic prose. Pure config data;
routes through the existing re-paint rule.

## D45 — Icon panels and price pills are composition, not leftovers

**Problem (smoke run):** a category icon slot rendered as a ~950px panel with a small icon
floating in the middle (judge: "amateurish placeholder"), another as a skinny vertical strip; and
size/variant pills rendered tiny, low-contrast, with label/price pairs wrapping apart (legibility
major shipped).

**Decision (two contract lines):** an ICON PANEL is a compact, deliberate banner/square — icon
scaled to fill most of the panel, caption integral, never bigger than its own section's content,
never a floating glyph in a void, never a tall skinny strip. PILLS & VARIANT LABELS are readable
units — label + price never wrap apart, high-contrast tokens at legible sizes, size pills aligned
under their item name.

## D46 — Content-aware dead-band, precise refs everywhere, card-interior clustering, and curated icon glyphs

**Problems (second smoke run):** (1) the D44 dead-band check stayed silent on a board whose lower
half the judge called empty — a full-height TINTED panel counted every grid row as "filled"
(painted ≠ says anything); (2) three contrast findings shipped with fg literally == bg (invisible
text, 1.00:1) but ref "span" — the sampler's fallback for text OUTSIDE item cards was a bare tag,
un-repairable by construction; (3) the sparse-card desc↔price void survived a third judge reject —
no contract line governed CARD INTERIORS and the rubric never named it; (4) icon-kind category
slots shipped "unappetizing dark blobs" — LLM-drawn food art is unreliable and icon quality must
not depend on it.

**Decisions:** (1) the observation now carries `rowContentFill` (text/img/svg hits only, same
sampling pass) and dead-band keys on it — painted-but-contentless bands fire; (2) non-card text
gets a short unique path ref (landmark or nth-of-type chain), and the contrast repair accepts
path-scoped refs while bare tags stay unfixable; (3) a CARD INTERIOR contract line (name/desc/
price stack as ONE tight cluster; tall cards absorb height OUTSIDE the cluster) + rubric wording
naming the desc↔price void so the critique scores it; (4) the engine ships a curated set of 13
clean, token-safe food-category SVG glyphs (line-art, currentColor) — the painter only PICKS a
glyph by name via `<svg data-icon="…">` and the packager inlines it (unknown → generic platter),
mirroring the photo-placeholder scheme. LLM judgment on rails: taste chooses the glyph, the
engine guarantees the drawing.

## D47 — Paint reasoning back ON: the eval suite refereed the A/B, quality won

**Evidence (full runs, same day):** with reasoning OFF (D42) paint got ~4× cheaper/faster —
but the model started violating basic contract rules it previously honoured: 8 raw-hex token-lint
majors across 3 boards, a duplicated cut-off header, weaker fill compliance; judge ship-rate fell
8/15 → 7/15 despite six intervening fix waves. The reasons reasoning was disabled (32k-cap
truncations, 19-minute calls, retry spend) are now independently contained by D34 truncation-retry,
D42's enforced per-attempt timeout, and the D32 Sonnet fallback. Cost delta ≈ $2.60/full-run.

**Decision:** `reasoning.paint` default back to `{ effort: "low" }` (effort does NOT cap GLM —
measured 70% reasoning share — but reasoning-on measurably buys contract compliance). The doc
comment carries the A/B story so this isn't relitigated blind.

## D48 — QA judges only what a guest can SEE: hidden carousel slides are exempt from image checks

**Problem (run 5):** image-crop(major) ×17 — 16 of them on two dense boards' shared carousels,
whose up-to-8 stacked slides sit at opacity 0 by design; the crop check graded every hidden slide
and flooded the reports on exactly the boards carousels were built for.

**Decision:** the render observation records each image's effective visibility (own/ancestor
opacity 0, display none, visibility hidden) and the crop check skips non-visible images. Old
observations without the field behave as before.

## D49 — An item with no price never renders an empty price chip

**Problem (run 5, judge reject):** menu-lint's hide policy (D29) blanks the $0 text but the
painter still drew the price CONTAINER — shipping hollow chips and leaders-to-nowhere that read
as "missing price boxes" (the exact defect the product rule "prices properly there" targets).

**Decision:** the paint digest marks such items `"priceless": true` (derived from the same
price-detection logic as menu-lint — no re-lint in the adapter) and a directive renders them
NAME-ONLY (optionally a small theme-toned "ask"/"MP" tag) — never an empty chip, hollow
data-bind span, invented $0.00, or a dotted leader running to nothing.

## D50 — Category image slots are enforced by QA, not just requested by the prompt

**Problem (run 5):** one board shipped with BOTH its per-section slots missing — the eval grader
saw it; the engine loop didn't (the board even passed QA). A prompt-level guarantee is not a
guarantee.

**Decision:** new structural check `image-slot-missing` (major, content, unfixable → re-paint):
every plan section carrying an imageSlot must render its `data-image-slot="<title>"` element, and
a planned board-level slot must render `data-image-slot="shared"` — matched with exactly the
harness grader's escaping so engine and evals agree. Structural checks now run against the
photo-truth-filtered effective screen, so slots legitimately dropped for failed photo fetches
don't false-fire.

## D51 — An aborted attempt is a timeout, whatever costume the SDK dresses it in

**Problem (run 6):** two boards crashed `AbortError: This operation was aborted` on their FIRST
paint attempt — zero retries, no fallback. The D42 per-attempt timeout fired correctly, but the
OpenAI SDK surfaces aborts inconsistently: a pre-header abort becomes its APIUserAbortError, while
an abort during the slow response-body parse — the exact window the timeout exists to bound —
escapes as a raw DOMException("AbortError") outside the SDK's own wrapping. The retry loop's
transient predicate was blind to that shape and rethrew it as terminal; only the D28 bulkhead
saved the fleet.

**Decision:** both request paths classify an abort-shaped error (APIUserAbortError, name
AbortError/TimeoutError, or cause-chained) under an armed per-attempt signal as a TRANSIENT
timeout — consume the attempt, retry, then fall back — regardless of `signal.aborted` races. Full
exhaustion by timeout surfaces a legible "timed out on every attempt" error (original as cause),
never a bare AbortError. No user-initiated aborts exist in this codebase, so the predicate stays
scoped to armed-signal attempts.

## D52 — Copy whitelist: every string on screen must trace to a real source

**Problem (run 6, product review):** with no brand input and no rule against it, painters filled
prime screen real estate with invented copy: filler badge chips ("PRICE LIST", "USD", "MADE TO
ORDER", "DINE IN · TAKEOUT", "FRESH · HOT · DAILY"), fake operational claims, and — worse — a
fabricated restaurant identity per board ("MANDI HOUSE", "HASHTAG CURRY HOUSE", "SPICE STREET
KITCHEN"); one board leaked the THEME's internal name ("Blockframe Café") as the restaurant. Six
boards of one restaurant read as six different restaurants.

**Decision:** new ENGINE_CONTRACT bullet: every string must trace to the menu data, the plan
(board title, section titles), the provided brand block, or a legend for a marker actually used —
invented badges, taglines, operational claims, restaurant names, and the theme's name are banned.
Enforced from both sides: two new default anti-patterns (shared painter+critic) and a new vision
rubric dimension `invented-copy` (weight 0.75, fails at major). Filler is a judgment call, so
this stays prompt+critic, not a deterministic check.

## D53 — Standard masthead: computed board title left, brand right, identical across the set

**Problem:** the engine had ZERO masthead guidance — no title rule, nothing pinning the header
treatment. Headers drifted yellow/white/cream/black across one set, and each board invented its
own name (D52). The eval harness held the real restaurant name all along but only used it for
trace correlation — the painter never saw it.

**Decision:** (a) `expandLayoutToPlan` stamps every screen with a deterministic `title` = its
section display names joined with " · " (new optional `title` on planScreenSchema) — the generic
category-list title the product owner asked for; (b) new MASTHEAD contract bullet: exactly one
slim content-hugging band at the top, board title LEFT, brand (logo + name) RIGHT when provided,
identical treatment on every screen of a set, and never an invented identity when brand is absent;
(c) brand prompt lines (D18) reworked from "own header band" to "right side of the masthead";
(d) every theme ships a `masthead` component recipe binding the band to that theme's own tokens —
the treatment is pinned per theme, not left to per-board improvisation; (e) the eval harness now
passes each case's restaurant as `brand: { name }`, so boards finally show the real name.

## D54 — Category hero photos and subtitles place by orientation

**Problem (product review):** landscape boards stacked a small photo next to a mostly-EMPTY
full-width color band (two boards shipped with a giant hollow yellow banner); portrait had only
generic flow guidance. No rule anywhere said where a category's photo or description subtitle
belongs relative to its title.

**Decision:** per-request orientation rules in the paint prompt — landscape: the category hero
photo sits BESIDE its category title (title + description subtitle on the other side), hero bands
content-hugging, never a tall stacked band with empty color fields; portrait: photo ABOVE the
title at full column width, subtitle BELOW the title. The image-slot contract bullet points at
these per-request rules so slot anchoring and placement can't diverge.

## D55 — Painters know they are painting one screen of a family

**Problem:** each board of a multi-screen set was painted in total isolation — the request carried
no hint that siblings exist, so per-board "creative variation" (different masthead colors, chip
vocabularies, brandings) was the natural outcome.

**Decision:** `PaintRequest` gains optional `board: { index, total }` (wired only when the plan
has >1 screen) and the prompt gains a BOARD FAMILY directive: screen N of M hung side by side,
ONE visual system — identical masthead treatment, section-header recipe, price treatment, and
canvas background token; never restyle or re-brand relative to siblings. Cross-board consistency
is still unmeasured by QA/graders (each judges one board) — candidate for a future set-level
grader.

## D56 — A truncated response body is a network failure, not a crash

**Problem (masthead validation run):** two boards crashed `SyntaxError: Unexpected end of JSON
input` — the provider cut the connection mid-body, the OpenAI SDK's own response parse threw a
raw SyntaxError (neither APIError nor abort-shaped), and the retry loop's predicates were blind
to that costume: zero retries, no fallback, one board burned 1714s then died. Same disease as
D51, third costume. (The same run window also saw the planner fail "response was not valid JSON"
on every attempt — provider instability, one bad hour.)

**Decision:** both request paths classify a SyntaxError thrown by the SDK create() call as
TRANSIENT (`isBodyParseError`, instanceof check — never message-matching, never our own parse
sites, which keep their in-band invalid-JSON re-ask). Retries with backoff, engages the fallback
model, and exhaustion surfaces a legible wrapped error with the SyntaxError as cause — never a
bare SyntaxError.

## D57 — The masthead pays for itself in the vertical budget

**Problem (masthead validation run):** two of four completed boards shipped their bottom row cut
off (both judge rejects) — the morning run without a masthead had ZERO overflow. Self-inflicted:
D53 made every board draw a masthead band, but the deterministic type-scale budget still handed
the painter the full pre-masthead canvas height, so content planned ~6-8% too tall and the last
row slid off the bottom edge.

**Decision:** `bodyHeight()` — the single chokepoint all row/type arithmetic routes through —
now reserves a 6%-of-canvas masthead allowance in both orientations (landscape body 880→815px,
maxRows 20→18; portrait 1720→1605px). The size directive tells the painter the budget ALREADY
reserves the band (no double-reserving), and the contract cap was aligned to the same 6%.
Corollary: the elastic board-count budget packs slightly fewer rows per board — the honest
consequence of every board carrying a masthead. Also tightened the landscape hero rule: a
category band hugs its content (≤ ~two title line-heights), spare room goes into bigger type or
tighter fit, never a taller band.

## D58 — The rescue model gets its own clock

**Problem (masthead validation runs):** on a night the primary paint model (GLM) stalled
constantly, the Sonnet fallback engaged exactly as designed — and was killed by the SHARED
per-attempt timeout on every big-board attempt: 29 fallback calls in one evening, 22 dead at
precisely 300.00s, 3 boards crashed "timed out on every attempt". The fallback is slower but
steady; a 40+ item board takes it more than 300s of pure generation, so the leash that rightly
strangles a stalled primary (healthy GLM paints in 20-40s) structurally guarantees the rescue
model can never rescue the boards that need it most.

**Decision:** new config `fallbackRequestTimeoutMs` (default 900000 = 15 min): per-attempt abort
budgets are selected by model index — primary keeps the tight `requestTimeoutMs` leash, fallback
attempts get the extended budget (the last line before a crashed board trades wall-clock for
survival; D28 bulkheads bound the damage per board). The SDK client-level header timeout is
lifted to the max of the two so it can't undercut the fallback. Exhaustion errors now name both
models tried ("z-ai/glm-5.2, then fallback anthropic/claude-sonnet-4.6") so a crashed board's
log tells the whole story.

## D59 — Every item's box must sit fully inside the screen (clipping is invisible to scroll math)

**Problem (masthead validation run D):** two boards shipped with a section's last items sliced
off at the bottom screen edge — engine QA scored BOTH 1.00 and the judge rejected both. The
overflow check compares page scrollHeight to the viewport, but the cut content sat inside an
overflow-clipped container: nothing scrolled, so the check was blind, and the vision critic
missed it too. Same boards also showed the failure's cause: one column clipped while a sibling
column sat on rows of empty space, and one spare panel was filled with abstract placeholder art.

**Decision:** the render observation now records a layout rect per data-item-id (union across
elements; getBoundingClientRect reports layout position even when an ancestor visually clips it —
which is exactly what makes silent clipping detectable). New rendered check `item-cutoff`: every
item rect must sit fully inside the viewport (tolerance 2px, config); violations produce one
major/content/unfixable finding naming the cut items and worst overhang — a scale repair cannot
un-clip a clipping container, so it routes to re-paint with the exact item list. This encodes the
product's core guarantee ("every item readable on screen") deterministically instead of trusting
scroll math or model eyes. Corollary prompt rules: COLUMN BALANCE (sibling columns end within ~a
row of each other — rebalance or drop a type rung, never clip) and an anti-pattern banning
placeholder art in spare panels.

## D60 — The prompt states each fact once, in its authoritative form (prompt-synthesis wave)

**Problem (prompt audit 2026-07-06, over real Braintrust prompts):** the painter/critic prompts
had grown by accretion, so the same fact reached the model twice in conflicting forms. Worst: the
planner's free-text `layoutHint` was dumped raw inside the plan JSON right above the authoritative
LAYOUT STRATEGY it contradicted, and a contract bullet unconditionally ordered "FOLLOW it".
Also: the board image-slot ids were serialized twice for the painter (raw JSON + the dedicated
directive that carries the actual placement/caption semantics); the items payload leaked the
mis-cased raw source `category` taxonomy ("FALOODA'S") as a competing sub-heading source plus an
unused `photoCount`; the 13-name food-icon glyph list was emitted twice; PILLS guidance shipped
on menus with no sizes/variants to pill; the price-ladder blueprint said "at most one shared
hero if space allows" while the density directive on the same board said the hero is plan-gated;
and the planner was offered a "variant-rows" representation the Rules never define.

**Decision (full plan: design-explorations/prompt-audit-2026-07-06.md):** the serialized plan is
slimmed per consumer before it enters a prompt: `layoutHint` is omitted except for matrix
sections (MATRIX_FIRST_STRATEGY genuinely references it) and the "FOLLOW it" bullet is deleted;
the painter's copy also drops `imageSlot` (the dedicated directive is the single source) while
the critic's copy keeps it (the critic has no other way to see the required carousel). The items
payload drops `category` and `photoCount` (the photo-id allowlist stays — load-bearing
anti-hallucination rail). Icon-panel guidance and the glyph list live only in the conditional
icon-slot branch, so they are emitted at most once and only when a board has icon slots; PILLS
is gated on the menu actually containing sizes/variants. The price-ladder line now uses the same
plan-gated wording as the density directive. The planner-facing `representation` enum is forked
to matrix/grid/list only — the internal schema keeps `variant-rows` because its structural check
is the sole guard that unpriced variant labels render.

## D61 — Themes may not license placeholder art; the critic is told what the shared carousel is

**Problem (same audit — root cause of the run-E judge reject):** every theme's `design.identity`
string licensed a decorative motif "standing in for any item without a photo". That string is
fed verbatim to BOTH the painter and the vision critic, so the painter was invited to draw
placeholder doodles and the critic was structurally unable to flag them — the judge-rejected
placeholder panel scored 1.00. Separately, the critic was never told the board-level `imageSlot`
is a required anchor, so it kept flagging the mandated carousel as a theme violation
(theme-adherence noise, 5 majors in run E).

**Decision:** the stand-in clause is deleted from every theme identity (bazaar never had one); a
new test asserts no theme identity may contain "standing in for" again. The critic rubric gains
one gloss line immediately before the serialized plan: `imageSlot` feeds the SINGLE shared photo
panel/carousel (D38), is NOT per-item photos, and is consistent with a type-led "no per-item
photos" strategy — the same two-consumers-same-text principle as D21. No new critic anti-pattern
rule: fixing the licensing data re-enables the existing balance/intentional-design dimensions.

## D62 — The re-paint self-check verifies the fix instead of re-auditing the board

**Problem (same audit):** the system contract's tail told every paint to "re-check your HTML
against this contract and fix any violation in place" — on a re-paint this contradicts the
re-paint directive ("make the MINIMAL change… preserving everything else") and invites the
restyling drift that makes iterations discard good work.

**Decision:** `buildSystem(theme, isRepaint)` swaps ONLY the tail self-check line on re-paint:
confirm the edit resolves EACH listed finding and introduces no new violation; do NOT re-audit or
restyle parts the findings don't name; the item-preservation safeguard (never drop/shorten a
planned item to make an edit fit — D34) is retained verbatim. The swap stays at the tail so the
system prompt's prefix is byte-identical between paint and re-paint and OpenRouter prompt caching
keeps working. The companion idea — a lean re-paint user prompt that drops the from-scratch
composition prose (C2 in the plan doc) — is deliberately HELD behind an eval A/B before shipping.
