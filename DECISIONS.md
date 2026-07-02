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
