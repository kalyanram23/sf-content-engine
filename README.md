# content-engine

A **stateless content-generation engine** that turns a normalized menu into finished
digital-signage screens. Each screen is a **self-contained, animated, data-bound HTML+JS
artifact** sized for a TV. The engine paints each screen — with full layout freedom, or from a
theme's component vocabulary ([two paint paths](#two-ways-a-screen-gets-painted)) — runs an
internal **generator–critic QA correction loop** until it passes (or the budget trips), then
**freezes** it — binding inventory state by canonical item ID so a downstream runtime can
patch availability/price later without regenerating layout.

```
generate({ items, brief, constraints }) → { screens, posters, qaReport }
```

It is built as a **framework-agnostic TypeScript (ESM) library** for a Next.js service to
import. The orchestration core is **pure and deterministic** — every external concern (LLM
painter, VLM critic, headless browser, Tailwind compiler, clock) is an injected port — so it
is fully testable with fakes and swappable in production.

- **Spec:** `docs/superpowers/specs/2026-06-22-display-content-generation-engine-design.md`
- **Architecture:** [`ARCHITECTURE.md`](./ARCHITECTURE.md) · **Decisions:** [`DECISIONS.md`](./DECISIONS.md)

## Why this design

A predecessor used an LLM to emit an IR rendered by fixed templates. It failed because a
rigid renderer gives the generator **fewer degrees of freedom than the critic can
critique**, so the correction loop couldn't converge, and templates can't express data-shape
variety (size/price matrices, variant rows). This engine fixes that: the painter writes
arbitrary HTML on **rails** (theme tokens, a motion vocabulary, deterministic packaging),
and a bounded QA loop with hybrid routing actually corrects the screen.

## Install

```bash
npm install content-engine
# For the real Node adapters (server-side), also install the optional peers:
npm install openai playwright-core tailwindcss @tailwindcss/node
npx playwright install chromium
```

The main entry (`content-engine`) is pure and has no heavy/Node-only dependencies. The real
adapters live behind `content-engine/node`; deterministic fakes behind `content-engine/testing`.

## Environment

Only the **Node adapters and live tests** read env (copy `.env.example` → `.env`). The hermetic
suite (`npm test` / `npm run verify`) needs **none** of this — it runs on fakes. Model routing is
**not** env; it's config-as-data (`createNodeEngine({ config: { models: … } })`, defaults in
`src/config/models.ts`).

<!-- AUTO-GENERATED:env (from .env.example — regenerate, don't hand-edit) -->

| Variable              | Required | Description                                            |
| --------------------- | -------- | ------------------------------------------------------ |
| `OPENROUTER_API_KEY`  | for live | Any real LLM call / the OpenRouter live test.          |
| `OPENROUTER_APP_URL`  | No       | OpenRouter attribution header (dashboard).             |
| `OPENROUTER_APP_NAME` | No       | OpenRouter attribution header (dashboard).             |
| `RUN_BROWSER_TESTS`   | No       | Set to `1` to enable the live Playwright browser test. |

<!-- /AUTO-GENERATED:env -->

## Quickstart (deterministic, no network/browser)

```ts
import { createFakeEngine, fixtures } from "content-engine/testing";

const engine = createFakeEngine();
const { screens, posters, qaReport } = await engine.generate(fixtures.input);

console.log(screens[0].html); // self-contained HTML+JS screen
console.log(qaReport.screens[0]); // { passed, flagged, iterations, score, findings, routeHistory }
```

Run the playground to see all the acceptance scenarios and write artifacts to
`./playground-output`:

```bash
npm run playground
```

## How the Next.js service consumes it (production)

`content-engine/node` is Node-only (it uses Playwright + Tailwind + OpenRouter). Import it
from a server action / route handler — never a React Server Component's render path.

```ts
// app/api/generate-screen/route.ts  (Next.js, server-side)
import { createNodeEngine } from "content-engine/node";
import { botanicalPreset } from "content-engine";

const engine = createNodeEngine({
  openRouterApiKey: process.env.OPENROUTER_API_KEY!,
  // Models are config-as-data — swap any role without code changes. The structured roles
  // (plan/critique/repair/compose) are checked against an allowlist at load, so an id that
  // can't do strict JSON fails loudly rather than silently shipping junk (D11).
  config: {
    models: { paint: "anthropic/claude-sonnet-5", critique: "openai/gpt-5.4-mini" },
    loop: { maxIterations: 3 },
  },
  // Optional: pass a hand-authored `plan` to bypass the LLM planner (wires StaticPlanner).
  // Omit it and the LLM coverage planner auto-distributes the whole menu across the screens.
  // Optional: `themesDir` loads externalized themes/<id>.theme.json at runtime.
});

export async function POST(req: Request) {
  const { items } = await req.json();
  const output = await engine.generate({
    items,
    brief: { presetId: botanicalPreset.id, density: "balanced" },
    constraints: { aspect: "16:9", screens: 2, locale: "en-US", currency: "USD" },
    // Optional: a logo header band on every screen. `src` may be a URL, an fs path, or a
    // data-URI — the Node root resolves it to a data-URI so the artifact stays offline-safe (D18).
    brand: {
      logo: { src: "./logo.png", alt: "Verdant" },
      name: "Verdant",
      tagline: "Garden kitchen",
    },
  });
  return Response.json(output);
}
```

For type-only use in RSC code, `import type { GenerateOutput } from "content-engine"` is
erased at compile time and pulls in nothing at runtime.

## Two ways a screen gets painted

Painting a screen has **two paths behind one interface**, chosen per screen — so the pipeline,
packaging, and QA below are identical either way.

- **Free paint** (the default, and the reason for the design above): the LLM writes arbitrary
  HTML on rails — theme tokens, a motion vocabulary, deterministic packaging. Maximum layout
  freedom; the QA loop is what makes it converge.
- **Composition** (D71): a theme can ship a **component vocabulary** — a small closed set of
  pre-built blocks. The LLM then only fills a tiny structured order (`section` / `group` /
  `photoBand`) and deterministic code renders it. It's cheaper, far lower-variance, and
  correct-by-construction — but only as expressive as the vocabulary the theme ships.

A theme opts into composition by declaring a `vocabulary` in its JSON; `dhaba` is the first one.
Everything else free-paints. `config.painter.mode` (`auto` | `free` | `composition`) overrides
this: `auto` (default) routes per theme and falls back to free paint if composing fails, while
`composition` forces it and fails loud — a CI/debug lever.

## The QA correction loop

```
plan → resolveTheme → fetchImages → paint → package → deterministicQA → visionQA → score → route ─┐
                                      ▲                                                            │
                        repair ───────┤  repair (deterministic token-swap, else LLM)              │
                                      │  paint  (minimal-change re-paint)                          │
                        re-plan ◀─────┘  plan   (structural capacity escalation)                  │
                                         freeze (ship best-scoring; flagged if budget spent) ◀────┘
```

`plan` is the LLM coverage planner (category-level judgment + deterministic 100% coverage; pass a
hand-authored `plan` to bypass it). `fetchImages` inlines item photos to `data:` URIs so paint/QA/
render never touch the network.

- **Deterministic pass** (headless Chromium, $0): WCAG contrast (**hard gate**), overflow,
  density, image-slot integrity, plus pure structural checks — binding integrity, token-lint,
  motion-vocab, self-containment + no-baked-player.
- **Vision pass** (cheap VLM): a structured rubric (balance, hierarchy, theme adherence,
  representation clarity, "intentionally designed vs AI-generic", decoration-vs-legibility).
- **Routing** (rules-as-data): mechanical/deterministically-fixable → `repair`; structural
  capacity → `plan`; otherwise → `paint`; nothing actionable or budget spent → `freeze`.
- **Best-scoring is preserved** across iterations, so a worse later iteration never wins.

It runs as an observable **LangGraph `StateGraph`** with checkpointing (time-travel/replay
for debugging the loop), kept entirely build-time — nothing LangGraph ships to the player.

## Data binding (runtime patch contract)

Every item node carries its canonical ID and explicit hooks:

```html
<article class="menu-item" data-item-id="id4" data-available="true">
  <span data-bind="price">12.99</span>
</article>
```

A downstream runtime scopes to `data-item-id` and targets `data-bind` hooks to apply live
availability/price — no LLM, no re-layout. The engine bakes default state in so the artifact
is a correct offline fallback on its own.

## Scripts

<!-- AUTO-GENERATED:scripts (from package.json — regenerate, don't hand-edit) -->

| Command                 | What                                                                  |
| ----------------------- | --------------------------------------------------------------------- |
| `npm run verify`        | format-check → lint → typecheck → test (CI gate, hermetic)            |
| `npm test`              | unit + e2e suite (fakes; no network/browser)                          |
| `npm run test:live`     | gated adapter tests (needs `OPENROUTER_API_KEY` and/or a browser)     |
| `npm run build`         | bake motion bundle (prebuild), then ESM + `.d.ts` for the 3 entries   |
| `npm run playground`    | run the engine on fixtures → `./playground-output`                    |
| `npm run try`           | drive the real Node engine on a menu end-to-end (needs a key)         |
| `npm run eval`          | run the eval harness on frozen scenarios → `eval-output/scorecard.md` |
| `npm run regen:samples` | regenerate the `samples/` fixtures from source menus                  |

Full script reference: [`docs/CONTRIBUTING.md`](./docs/CONTRIBUTING.md#scripts).

<!-- /AUTO-GENERATED:scripts -->

## Extending

Most changes are **data, not code** (see ARCHITECTURE "How to extend"): add a routing rule,
QA threshold, theme/motion preset, or swap a model in `ModelRouting`. New checks, pipeline
stages, or LLM vendors implement a small interface and wire in at the composition root.

## Status / scope

The walking skeleton (spec §7) plus several §8 slices now ship:

- the **LLM coverage planner** distributing the whole menu across **multiple screens**
  (a hand-authored `plan` still bypasses it);
- **externalized JSON themes** in `themes/` — `botanical`, `bubblegum`, `bazaar`, `blockframe`,
  `bold-poster`, `dhaba`;
- the **composition paint path** (above) — `dhaba` is the first theme to ship a component
  vocabulary;
- an **optional brand header band** (logo + name/tagline, resolved to an offline `data:` URI);
- an **item-photo carousel** (photos fetched and inlined as offline `data:` URIs).

Still deferred (§8): brief-driven theme generation, image-model-generated backgrounds,
hide+reflow out-of-stock, and the runtime gray-out patcher (a downstream service — the binding it
relies on already ships).
