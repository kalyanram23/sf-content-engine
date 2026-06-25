# Display Content Generation Engine — Design Spec

**Date:** 2026-06-22
**Status:** Approved design (brainstorm → spec)
**Supersedes:** the template/IR rendering approach in `DISPLAY_ENGINE_PIPELINE.md`. Keeps that doc's framing of the problem (§0–§1), the two-kind asset strategy (§1.4), and the cost levers (§6); replaces its "deterministic templates" thesis (§3) and template-rendering pipeline (§4).

---

## 1. Summary

A **stateless content-generation engine** that turns a normalized menu into finished digital-signage screens.

```
generate({ items, brief, constraints })  →  { screens, posters, qaReport }
```

Each screen is a **self-contained, animated, data-bound HTML+JS artifact** sized for a TV. The engine generates each screen with a large amount of layout freedom (the LLM "paints" it), then runs an **internal generator–critic QA loop** that corrects the screen until it passes, then **freezes** it. Inventory state (out-of-stock, price) is bound by canonical item ID so it can be updated later without regenerating layout.

The engine's job ends when the screens are produced. Approval, publishing, and the runtime/operational loop are **downstream services, out of scope**.

---

## 2. Why the template approach was abandoned (the core lesson)

The predecessor used an LLM to emit a structured IR and a **fixed library of layout templates** to render it. It failed in production for two reasons:

1. **The correction loop had no levers.** When the vision critic said "screen 3 has dead space at the bottom — rebalance," a fixed template had nothing to rearrange. The generator could not *actuate* the feedback, so the bounded loop (2–3 iters) changed nothing. The loop was theater.
2. **Templates can't express data-shape variety.** A pizza size/price matrix (8″/10″/11″), protein-variant rows (Veg/Paneer/Egg/Chicken), a comparison grid — each is a *different representation of the same data*. A page-template library either needs one rigid template per shape (combinatorial explosion) or simply can't render it.

**Root cause — the design principle going forward:**

> A rigid renderer gives the generator **fewer degrees of freedom than the critic can critique**. For a generator–critic loop to converge, the generator's control surface must be a **superset** of the critic's feedback surface.

Templates violate that. Everything below follows from fixing it.

---

## 3. Engine boundary (scope)

The engine is a **stateless function**. Same inputs → same screens. It holds no state between calls and performs no side effects beyond returning artifacts.

```ts
generate({
  items: CanonicalItem[],     // from the existing upstream normalizer
  brief: ThemeBrief,          // preset id + optional NL extensions (see §5.3)
  constraints: {
    aspect: "16:9",           // v1: 16:9 only
    screens: number | "auto", // v1: 1
    locale, currency, ...
  }
}): {
  screens:  SelfContainedScreen[],  // HTML+JS, data-bound, frozen, offline-safe
  posters:  Png[],                  // 1920×1080 render, one per screen
  qaReport: QaReport,               // per-screen rubric results, pass/fail, iteration count
}
```

**In scope (the engine):** thin plan → theme resolve → free paint on rails → QA correction loop → frozen, data-bound, self-contained screens + posters + QA report.

**Out of scope (downstream services that *consume* the output, or decide *when* to re-invoke the engine):**
- Human review / approval
- Publishing, CDN, versioning
- The runtime gray-out **patcher** (applies live availability to a running screen)
- Inventory webhooks + dayparting orchestration

The engine is **re-invokable per screen** (regenerate one screen — see §6), but it does not decide *when*; a downstream orchestrator calls it.

---

## 4. Core architecture: "free paint on rails," with a freeze boundary

The screen is neither a baked image nor a library template. It is a **data-bound shell** that passes through two lifecycle phases:

| Phase | Layout | Who controls it |
|---|---|---|
| **Design time** (generation + QA loop) | Fully malleable — re-painted freely each iteration | The engine (LLM + critic) |
| **Runtime** (after it ships) | **Frozen** — only *data* flows through it | Downstream services |

The freeze happens at the design/runtime boundary. This is what reconciles "free paint" (needed for the loop and for representation variety) with "map data to source" (needed for cheap inventory updates): they live on opposite sides of the boundary and never conflict.

**Three layers survive** — not rigid templates, not fully freeform:

1. **Thin plan** (content allocation + representation hints) — §5.4
2. **Free paint** (bespoke self-contained HTML+JS, generated on rails) — §5.1/§5.2
3. **Data contract** (canonical-ID binding for runtime updates) — §5.5

**The canonical ID threads the whole way through** — this *is* the data-to-source mapping:

```
canonical item  →  plan (items:["id4"])  →  painted shell (data-item-id="id4")  →  runtime patch
```

---

## 5. Subsystems

### 5.1 Output contract — the screen artifact

- **N self-contained screens, no cross-screen auto-advance.** The host owns sequencing, dwell, transitions, dayparting. The engine never bakes in a player.
- **Standalone HTML+JS per screen** with **intra-screen motion** (galleries cycling photos, ambient drift, staggered entrances). The screen animates forever but never navigates away.
- **Self-contained / offline-safe:** inline CSS + JS, self-hosted fonts, assets as data-URIs. Must run on cheap embedded players with flaky networks.
- **A PNG poster** (1920×1080) is rendered per screen — used for QA, thumbnails, and as a last-ditch static fallback. The poster is a by-product, not the product.

### 5.2 The rails

The rails are what keep "LLM writes HTML" from being chaos. **None of them constrains layout** — that freedom is the whole point.

- **Tokens, enforced — authored in Tailwind.** The theme tokens (color / type / spacing / radius) are mapped **into the Tailwind theme config** (Tailwind compiles them to CSS variables anyway), and the LLM paints in **Tailwind utility classes**. The token-lint rail stays: a lint pass rejects raw hex/px outside the token scale. → theme consistency without layout rigidity. Tailwind is the highest-training-density UI format, so paint quality and generator–critic loop convergence are higher than with raw-CSS-var authoring; Tailwind and design tokens **compose**, so this does not weaken token enforcement.
- **Motion as a vetted layer.** The LLM never hand-rolls a `requestAnimationFrame` loop. Motion is applied via **Motion ([motion.dev](https://motion.dev)) — its vanilla-JS API** (MIT-licensed, ~3KB, built on the Web Animations API, offline-safe). The `data-motion` vocabulary (`data-motion="gallery-fade"`, `data-motion="stagger-in"`) maps to **named Motion presets**, not custom rAF code; the LLM *chooses and parameterizes* motion. **Pure CSS is reserved for trivial fades/entrances; the Motion runtime is used only for orchestrated/sequenced motion.** → expressive but never janky.
- **Deterministic packaging.** A post-process step **compiles Tailwind to static CSS** (no runtime), inlines fonts/assets, and guarantees self-containment regardless of what the LLM wrote — keeping the output compatible with the self-contained / offline-safe requirement (§5.1).
- **QA is the guardrail.** Templates used to enforce correctness up front; instead it's enforced *after* generation (§5.6). Because the LLM controls the markup, it can act on the feedback — the loop has teeth.

> **Deferred rail:** reflow-tolerant layout. Only needed when out-of-stock items *disappear* (hide+reflow). v1 uses gray-out-in-place (§5.5), so nothing reflows at runtime and this rail is not required yet.

### 5.3 Theme model — presets you can extend

A curated library of named themes (botanical, luxury, …). Each preset is a vetted bundle of **tokens + motion vocabulary + assets**. The NL brief **starts from a preset and perturbs it** (override palette, swap a motif, dial density) rather than building a theme from zero.

- Keeps a **legibility/quality floor** (vetted preset) *and* lets the brief genuinely shape the design — the feature from the POC worth preserving.
- **Bounds the expensive part:** image-model backgrounds are generated **once per preset** (cached, reused across every tenant on that theme), never per render. Procedural SVG handles per-tenant decoration for free. A brief override mostly changes *which token values* the paint sees plus motif/motion selection — it rarely triggers fresh image-gen.
- The resolved tokens flow into the free paint as the rails (§5.2).

### 5.4 Thin plan (content IR)

A small structured plan — **content allocation + a representation hint per section**. It is *not* template/layout selection (the doc's original mistake); layout is the paint's freedom.

```json
{
  "screens": [
    { "id": "screen-1",
      "imageSlot": { "categoryId": "pizzas", "items": ["id1", "id4"] },
      "sections": [
        { "title": "PIZZAS",
          "representation": "matrix",      // matrix | variant-rows | grid | list
          "items": ["id4", "id7", "id9"] }
      ] }
  ]
}
```

- References items by **canonical ID** (threads the data mapping).
- **Schema-enforced.** The plan is produced via **structured outputs / JSON Schema (Zod)**, not free-form JSON — guaranteeing parseable output, matching the Zod-at-every-boundary convention, and keeping the loop's routing deterministic.
- **Representation hint** is how data-shape variety is handled (a `matrix` for size/price, `variant-rows` for protein variants) — the paint renders it freely.
- Stays cacheable and diffable: dayparting / 86'd-item changes become a minimal plan diff, not a full reshuffle.
- **v1:** the plan is hand-authored for one screen to isolate the risky part (paint + loop). The LLM planner is a later slice (§8).

### 5.5 Data binding & out-of-stock behavior

Every item node in the painted shell carries its canonical ID, and dynamic content must use explicit sub-node bindings:

```html
<article class="menu-item" data-item-id="id4" data-available="true">
  <!-- The layout inside is fully "free paint", but the dynamic text hook is explicit -->
  <span data-bind="price">12.99</span>
</article>
```

- The binding is the **data-to-source map**. A downstream runtime scopes to `data-item-id` and specifically targets explicit hooks (like `data-bind="price"`) to apply live state — **no LLM, no re-layout, and no fragile regex parsing of complex DOM trees.**
- **v1 out-of-stock behavior: gray-out in place.** The node stays, styled "sold out." Layout is 100% stable, zero reflow risk.
- **Hide + reflow is deferred** (§8) — it needs the reflow-tolerant rail.
- Price changes ride the same data path.
- The binding **doubles as a QA anchor** (§5.6): every planned item present, none duplicated, specific `data-bind` targets exist, and price matches source — programmatic correctness, not just vision.

### 5.6 QA correction loop (inside the engine)

Two passes, then routing, bounded.

**(a) Deterministic pass** — headless Chromium, $0, catches the "broken":
- **Target Resolution Check:** Chromium must be instantiated with the exact viewport pixel dimensions (e.g., `1920x1080`) and Device Pixel Ratio of the target display, rather than a generic aspect ratio.
- Text clipping / overflow (`scrollHeight > clientHeight`, bbox past edge) — *relies entirely on the strict resolution check above to be accurate.*
- **Contrast ratio (WCAG) — hard gate.** Legibility across a room is the whole game for signage; never advisory.
- Density bounds (flag > 85% full or < 40% empty)
- Every planned `data-item-id` present + unique + explicit `data-bind` hooks exist; price/text matches source.
- Image-slot integrity (galleries actually loaded)

**(b) Vision pass** — cheap VLM, fed the screenshot **+ the plan** (so it knows what *should* be there). Forced into a **structured rubric** via **structured outputs / JSON Schema (Zod)** (per screen, severity + region — never free text), matching the Zod-at-every-boundary convention so the loop's routing is deterministic: balance, hierarchy, theme adherence, representation clarity, "intentionally designed vs AI-generic," decoration-vs-legibility.

**Routing — hybrid weighted toward re-paint-first:**
- **Mechanical fixes route away from the painter.** Fixes surfaced by the deterministic pass (e.g., contrast token swap, overflow trim) are handled by a **cheap model or a deterministic transform** — never the frontier paint model. Reserve frontier paint for actual layout **re-paints**.
- The critic tags each finding *layout* vs *content* as a **hint**.
- Default: **re-paint that screen** (minimal change, no reshuffle).
- **Escalate to re-plan** only when the critic flags a hard *structural* problem a re-paint provably can't solve (e.g., 8 items crammed into a 4-slot region).
- Minimal-change-first keeps diffs stable (good for later dayparting).

**Loop control:** bounded 2–3 iterations. Budget exhausted → ship the best-scoring screen and flag it in `qaReport`. (No human gate — that's downstream.) The loop and its routing run as a LangGraph `StateGraph` — see §5.7.

### 5.7 Orchestration runtime — LangGraph JS (and why: debuggability)

The whole engine pipeline — *thin plan → theme resolve → free paint → deterministic QA → vision QA → route → freeze* — is a **stateful graph with a cycle** (the bounded QA correction loop). That is exactly the shape LangGraph JS (`@langchain/langgraph`) models, so the engine is built as a **`StateGraph`** rather than hand-rolled control flow.

**Mapping the engine onto the graph:**
- **Nodes** = pipeline stages: `plan`, `resolveTheme`, `paint`, `deterministicQA`, `visionQA`, `repair`, `freeze`.
- **Typed state** = the screen-in-progress (plan, current HTML, QA findings, iteration count, best-score-so-far). State is a **Zod `StateSchema`**, which composes with the schema-enforce convention (§5.4, §5.6) — the same Zod types are both the graph's state *and* the structured-output contracts.
- **Conditional edges** = the §5.6 hybrid routing: a router reads QA findings from state and returns the next node — `repair` (mechanical; cheap model / deterministic transform), `paint` (re-paint), `plan` (re-plan), or `freeze`. The cheap-vs-frontier model split (§5.6, §9) is just *which node* the router selects.
- **The cycle** = the bounded loop: QA nodes route back to `paint`/`repair` until pass or the 2–3-iteration budget trips, then to `freeze`.

**Boundary (critical).** LangGraph is the engine's **build-time orchestration runtime only**. It runs in the Node/TS generation process and is **never shipped to the player**. The emitted artifact stays a self-contained, offline-safe HTML+JS screen (§5.1, §10): LangGraph orchestrates *how the screen is made*, not *what runs on the TV*. (LangSmith, below, is likewise dev/eval-time and can be fully disabled — see §9.)

**Why this matters — debuggability to evaluate and improve the engine.** The QA loop is the risky core (§2), and the hard question in production is *why a screen failed to converge*. LangGraph makes the loop observable:
- **Checkpointed state per step** (a checkpointer, e.g. `MemorySaver` or a persistent store): every iteration's plan, HTML, findings, and routing decision is captured, not lost between iters.
- **Time-travel replay + fork** (`getStateHistory` → replay from a checkpoint, or `updateState` to fork): replay *just* the failing iteration, or **fork from "before re-paint" with a tweaked prompt / rubric / model** and compare outcomes — *without* re-running plan+paint. This is the cheap, deterministic way to tune the painter and rubric.
- **Streaming** (`streamMode: "updates" | "values" | "debug"`): watch each node's I/O live as the loop runs.
- **LangSmith traces** *(opt-in; off by default — see §9)*: per-run traces of every painter/critic call (prompt, output, latency, cost), tagged per screen/preset. When enabled these feed the eval harness (§9) directly (convergence rate, wasted iterations, recurring findings); until then the same data is available locally via checkpoints and Studio.
- **Studio**: a free local visual debugger (`npx @langchain/langgraph-cli`) to step the graph, inspect intermediate state, and iterate on inputs without redeploying.

> **Suggestion (for the implementation plan):** use the **Graph API** (explicit nodes/edges) over the Functional API — the routing *is* the design (§5.6), so an explicit, visualizable graph (`getGraphAsync().drawMermaidPng()`) is self-documenting. Multi-screen `screens:"auto"` (§8) maps cleanly onto the **`Send` API** (orchestrator → one worker per screen, fan-out).

---

## 6. Lifecycle & update tiers

Once frozen and shipped, changes to a screen fall into three tiers. The engine owns the bottom two (it is re-invoked per screen by a downstream orchestrator); the top tier never touches the engine.

| Tier | Trigger | Cost | Who |
|---|---|---|---|
| **Data path** | availability / price change | no LLM, instant | downstream runtime patcher (relies on the §5.5 binding) |
| **Re-paint** | a change breaks layout on one screen | LLM, 1 screen | engine |
| **Re-plan** | item-set *shape* changes, category reshuffle, new theme | LLM, may shuffle screens | engine |

---

## 7. v1 scope — the walking skeleton

Build the smallest thing that proves the core bet: **free paint + a correction loop that actually converges** — the exact thing templates couldn't do.

- **One screen, one preset** (botanical — assets already exist from the POC), 16:9.
- **Thin plan hand-authored** for that screen (isolates paint + loop).
- **Free paint** → one self-contained HTML+JS screen on rails: preset tokens, a tiny motion vocab, `data-item-id` binding baked in from day one.
- **Full QA loop** — deterministic + vision + hybrid routing, bounded iters.
- **Outputs:** the screen + PNG poster + QA report.

**Acceptance tests:**
1. **The loop fixes what templates couldn't (Vision Pass).** Seed the exact old failure — *dead space at the bottom of the screen* — and demonstrate the loop rebalances it within the iteration budget.
2. **The loop enforces hard gates (Deterministic Pass).** Seed a generated screen with failing WCAG contrast (e.g., white text on a yellow background), and demonstrate the Chromium pass catches it and the LLM safely swaps the CSS token to fix it within the budget.
3. **Representation variety renders.** A pizza size/price `matrix` and `variant-rows` render correctly from the plan.

Passing (1) and (2) validates both the layout freedom and programmatic guardrails of the entire pivot.

---

## 8. Deferred (post-v1 slices, rough order)

1. **Runtime gray-out patcher** (downstream service; the *binding* it depends on already ships in v1)
2. **LLM planner** — auto content allocation, multi-screen, `screens: "auto"`
3. **Brief-driven theme extension** — perturb preset tokens / motifs / motion from NL
4. **Image-model backgrounds** — per-preset, cached
5. **menu-cast integration** — wire the upstream normalizer seam; expose `generate()` as the API
6. **Hide + reflow out-of-stock** — requires the reflow-tolerant rail
7. **Human editing + edits-as-learned-preferences** (likely a downstream concern)
8. **Other aspects/resolutions** — 9:16, 4K

---

## 9. Open decisions (for the implementation plan)

- **Model routing** — which model plans vs paints vs critiques vs repairs (e.g., frontier paint (Sonnet), Opus for hard screens, cheap VLM critic, cheap model or deterministic transform for mechanical repairs, Opus adjudicator on low-confidence vision findings). **Caution:** do not use a cheap "web-specialized" small model as the *painter* — taste and layout coherence are exactly where small models fail. Keep frontier for paint; cheap models for critic/repair.
- **Motion vocabulary** — the actual preset list, defined as named **Motion (motion.dev)** presets. **GSAP is ruled out:** its license prohibits use in tools that compete with Webflow, and Webflow can revoke it at its discretion — unacceptable risk for a commercial design SaaS. Motion's MIT license carries no such restriction.
- **Availability delivery** — does the engine embed default state (re-emit on change) or does the downstream runtime live-fetch? Affects what the engine bakes in.
- **Token schema + lint rules** — the exact token set and how the lint enforces it.
- **Vision rubric** — exact fields, severity scale, scoring thresholds for pass/fail.
- **Orchestration runtime** — LangGraph JS Graph API is adopted for the pipeline + QA loop (§5.7). Still open: Graph vs Functional API; which checkpointer (in-memory for v1 vs a persistent store).
- **LangSmith tracing — off for now.** Default to **local-only** (`LANGSMITH_TRACING=false` → nothing leaves the box; debug via Studio locally). Turning on cloud tracing is **deferred** — revisit once we decide how to handle tenant menu data leaving the box.
- **Eval harness** — golden menus × the botanical preset, regression-scored; doubles as the rubric's offline test. LangSmith traces (§5.7) are the per-run data source (convergence, cost, recurring findings).

---

## 10. Design principles

1. **Generator DOF ⊇ critic feedback surface.** The reason templates were dropped.
2. **Cache the expensive, regenerate the cheap.** Image-gen per preset and the painted shell are cached; procedural SVG and data patches are regenerated freely.
3. **Themes are the moat.** A curated preset library is the quality floor *and* the LLM's guardrails.
4. **Legibility/contrast is a hard gate**, never advisory.
5. **Self-contained + offline-safe** — inline JS/fonts/assets, GPU-friendly motion, for cheap embedded players. Tailwind compiles to static CSS (no runtime) and Motion (motion.dev) is a ~3KB Web Animations API library — both authoring choices stay offline-safe.
6. **Minimal-change-first** — re-paint before re-plan, for stable diffs.
7. **The loop must be debuggable.** The QA correction loop is the core bet; it runs as an observable LangGraph `StateGraph` (checkpoints, time-travel, traces) so convergence can be *measured, replayed, and improved* — not guessed at.
