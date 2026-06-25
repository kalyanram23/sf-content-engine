# content-engine

A **stateless content-generation engine** that turns a normalized menu into finished
digital-signage screens. Each screen is a **self-contained, animated, data-bound HTML+JS
artifact** sized for a TV. The engine paints each screen with full layout freedom, runs an
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
  // Models are config-as-data — swap any role without code changes:
  config: {
    models: { paint: "anthropic/claude-sonnet-4.5", critique: "openai/gpt-4o-mini" },
    loop: { maxIterations: 3 },
  },
  // v1: hand-authored plan (the LLM planner is a later slice)
  plan: myThinPlan,
});

export async function POST(req: Request) {
  const { items } = await req.json();
  const output = await engine.generate({
    items,
    brief: { presetId: botanicalPreset.id, density: "balanced" },
    constraints: { aspect: "16:9", screens: 1, locale: "en-US", currency: "USD" },
    plan: myThinPlan,
  });
  return Response.json(output);
}
```

For type-only use in RSC code, `import type { GenerateOutput } from "content-engine"` is
erased at compile time and pulls in nothing at runtime.

## The QA correction loop

```
plan → resolveTheme → paint → package → deterministicQA → visionQA → score → route ─┐
                        ▲                                                            │
          repair ───────┤  repair (deterministic token-swap, else LLM)              │
                        │  paint  (minimal-change re-paint)                          │
          re-plan ◀─────┘  plan   (structural capacity escalation)                  │
                           freeze (ship best-scoring; flagged if budget spent) ◀────┘
```

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

| Command              | What                                                              |
| -------------------- | ----------------------------------------------------------------- |
| `npm run verify`     | format-check → lint → typecheck → test (CI gate, hermetic)        |
| `npm test`           | unit + e2e suite (fakes; no network/browser)                      |
| `npm run test:live`  | gated adapter tests (needs `OPENROUTER_API_KEY` and/or a browser) |
| `npm run build`      | ESM + `.d.ts` for `.`, `./node`, `./testing`                      |
| `npm run playground` | run the engine on fixtures → `./playground-output`                |

## Extending

Most changes are **data, not code** (see ARCHITECTURE "How to extend"): add a routing rule,
QA threshold, theme/motion preset, or swap a model in `ModelRouting`. New checks, pipeline
stages, or LLM vendors implement a small interface and wire in at the composition root.

## Status / scope

v1 is the walking skeleton (spec §7): one screen, one preset (botanical), hand-authored
plan, the full QA loop. Deferred (§8): the LLM planner + multi-screen (`screens:"auto"`),
brief-driven theme extension, image-model backgrounds, hide+reflow out-of-stock, and the
runtime gray-out patcher (a downstream service — the binding it relies on already ships).
