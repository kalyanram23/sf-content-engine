<!-- Generated: 2026-07-12 | Files scanned: src/ports/** src/adapters/** src/testing/fakes/** src/composition/** src/vocabularies/** | Token estimate: ~950 -->

# Ports & Adapters (the DI seam)

`EnginePorts` (`src/ports/index.ts`) is everything the pure core depends on; constructed only at a
composition root. `logger`, `debug`, `usage`, `llmRepairer`, `composer`, `vocabularies` are
**optional** (deterministic repairs are pure-core — D13). Two real LLM backends implement the LLM
ports: **OpenRouter** (prod) and **Claude-Agent-SDK** (`claudecode`).

⚠ **The `claudecode/*` adapters below are gitignored** (`.gitignore` + eslint `ignores`) — shelved,
out of the gate, and **absent from a fresh clone**. Read every `claudecode/…` cell as local-only.

## Port → real adapter → fake

```
port (interface)         real adapter (src/adapters/**, src/composition/**)   fake (src/testing/fakes/**)
──────────────────────── ─────────────────────────────────────────────────── ──────────────────────────
Planner.plan             openrouter/planner · claudecode/planner             fakes/planner
                         planner/static-planner StaticPlanner (plan given)     (StaticPlanner if plan given)
ThemeRepository.get      theme/file-theme-repository FileThemeRepo           theme/presets InMemoryThemeRepo
ImageFetcher.fetch       image/image-fetcher NodeImageFetcher                fakes/image-fetcher (data-URI)
Painter.paint            composition/auto-painter AutoPainter (D71, routes:) same AutoPainter over fakes
  ├ free path            openrouter/painter · claudecode/painter             fakes/painter (valid HTML)
  └ composition path     composition/painter CompositionPainter (real, pure) (same real class)
Composer.compose         openrouter/composer OpenRouterComposer (D71)        fakes/composer FakeComposer
VocabularyRegistry.get   vocabularies/index builtinVocabularies() (D71)      (same builtins — pure code)
Packager.package         tailwind/packager TailwindPackager                  fakes/packager
BrowserPort.render       playwright/browser PlaywrightBrowser                fakes/browser ScriptedBrowser
BrowserPort.measure      playwright/browser (same instance — D72)            fakes/browser (const heights)
VisionCritic.critique    openrouter/vision-critic · claudecode/vision-critic fakes/vision-critic Scripted…
LlmRepairer.repair       openrouter/repairer · claudecode/repairer           (optional; omitted)
Clock.now                node-engine SystemClock                             fakes/services (fixed)
IdGenerator.next         node-engine SystemIdGenerator                       fakes/services (counter)
Logger (optional)        caller-supplied                                     caller-supplied
DebugSink (optional)     caller-supplied (per-iteration capture)             —
UsageSink (optional)     OpenRouter/Claude adapters emit per-call tokens     —   (D28 cost telemetry)
```

`RequestCorrelation` (`src/ports/correlation.ts`) is **not** an `EnginePorts` member — it's a neutral
per-call trace context (runId/restaurant/screenId/iteration) threaded to the LLM ports; the OpenRouter
adapter turns it into provider `session_id` + `trace` (`adapters/openrouter/correlation.ts`).

## Adapter notes

- **OpenRouter** (`src/adapters/openrouter/client.ts`): one shared client; `requestStructured`
  (strict JSON schema, D11) + `requestText`. Painter/planner/composer/critic/repairer wrap it per
  role, each with a **resilience policy** (per-role attempt budget + optional fallback model —
  D42/D56) and optional `usage` telemetry. Opt-in Braintrust auto-instrumentation via `wrapOpenAI`.
- **Claude-Agent-SDK** (`src/adapters/claudecode/*`): mirrors the OpenRouter adapters but authenticates
  via a Claude Code subscription (no OpenRouter key); every role uses one `model`, `config.models` is
  ignored. No composer → **free-paint only**. Wired by `createClaudeCodeEngine` — test/local only.
- **Roles → models** are config-as-data (`config.models`: `plan`/`paint`/`critique`/`repair`/`compose`),
  validated against `structuredOutputAllowlist` at load (`src/config/models.ts`, D11). `compose`
  defaults to `anthropic/claude-sonnet-5`, reasoning off; it declares no `maxTokens`/`resilience`
  entry (model default + the structured re-ask) — only an optional, allowlist-checked `fallback.compose`.
- **The composition seam is the `Painter` port, not new graph wiring.** `AutoPainter` dispatches per
  board on `config.painter.mode` (`auto` default | `free` | `composition`, `src/config/painter.ts`) and
  whether the theme declares a `vocabulary`; in `auto` a composition failure **rescues** to free paint,
  forced `composition` fails loud. Both roots (`node-engine.ts`, `fakes/index.ts`) construct the
  `Composer` + `VocabularyRegistry` and inject them straight into `CompositionPainter`/`AutoPainter` —
  nothing in the core reads `ports.composer`/`ports.vocabularies` (those members exist for callers who
  override). `CompositionPainter` is pure; its only IO is the injected `BrowserPort.measure`.
- **ComponentVocabulary** (`src/ports/vocabulary-registry.ts`) is a theme's render package — pure,
  code not JSON, emitting engine-legal markup (`renderShell`/`renderSection`/`renderGroup`/
  `renderPhotoBand`/flow pieces + `metrics()` + `promptNotes`). `builtinVocabularies(extra?)`
  (`src/vocabularies/index.ts`) returns the registry Map; the only builtin is
  `dhaba` (`src/vocabularies/dhaba/`).
- **FileThemeRepository** loads `themes/<id>.theme.json` at runtime, **overriding** bundled presets by
  id; falls back to the bundle (`src/theme/presets/` — `botanical` only) for ids not on disk. Themes on
  disk: `bazaar`, `blockframe`, `bold-poster`, `botanical`, `bubblegum`, `dhaba` — only `dhaba` declares
  a `vocabulary`, so only it composes.
- **NodeImageFetcher** resolves remote photo URLs → `data:` URIs; resilient (a failed URL is omitted,
  caller substitutes a placeholder) so generation never hard-fails on a flaky host.

## Adding a dependency

Add a **port interface** in `src/ports/`, a real adapter in `src/adapters/**`, a fake in
`src/testing/fakes/`, and wire both at the roots (`node-engine.ts` / `claudecode/engine.ts` /
`fakes/index.ts`). Never reach for a global clock/IO/randomness in the core.
