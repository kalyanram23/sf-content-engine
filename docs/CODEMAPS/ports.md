<!-- Generated: 2026-07-11 | Files scanned: src/ports/** src/adapters/** src/testing/fakes/** | Token estimate: ~780 -->

# Ports & Adapters (the DI seam)

`EnginePorts` (`src/ports/index.ts`) is everything the pure core depends on; constructed only at a
composition root. `logger`, `debug`, `usage`, `llmRepairer` are **optional** (deterministic repairs
are pure-core — D13). Two real LLM backends implement the LLM ports: **OpenRouter** (prod) and
**Claude-Agent-SDK** (`claudecode`, test/local only).

## Port → real adapter → fake

```
port (interface)        real adapter (src/adapters/**)                     fake (src/testing/fakes/**)
─────────────────────── ────────────────────────────────────────────────  ──────────────────────────
Planner.plan            openrouter/planner · claudecode/planner            fakes/planner
                        planner/static-planner StaticPlanner (plan given)    (StaticPlanner if plan given)
ThemeRepository.get     theme/file-theme-repository FileThemeRepo           theme/presets InMemoryThemeRepo
ImageFetcher.fetch      image/image-fetcher NodeImageFetcher                (inline/no-op)
Painter.paint           openrouter/painter · claudecode/painter            fakes/painter (valid HTML)
Packager.package        tailwind/packager TailwindPackager                 fakes/packager
BrowserPort.render      playwright/browser PlaywrightBrowser               fakes/browser ScriptedBrowser
VisionCritic.critique   openrouter/vision-critic · claudecode/vision-critic fakes/vision-critic Scripted…
LlmRepairer.repair      openrouter/repairer · claudecode/repairer          (optional; omitted)
Clock.now               node-engine SystemClock                            fakes/services (fixed)
IdGenerator.next        node-engine SystemIdGenerator                      fakes/services (counter)
Logger (optional)       caller-supplied                                    caller-supplied
DebugSink (optional)    caller-supplied (per-iteration capture)            —
UsageSink (optional)    OpenRouter/Claude adapters emit per-call tokens    —   (D28 cost telemetry)
```

`RequestCorrelation` (`src/ports/correlation.ts`) is **not** an `EnginePorts` member — it's a neutral
per-call trace context (runId/restaurant/screenId/iteration) threaded to the LLM ports; the OpenRouter
adapter turns it into provider `session_id` + `trace` (`adapters/openrouter/correlation.ts`).

## Adapter notes

- **OpenRouter** (`src/adapters/openrouter/client.ts`): one shared client; `requestStructured`
  (strict JSON schema, D11) + `requestText`. Painter/planner/critic/repairer wrap it per role, each
  with a **resilience policy** (per-role attempt budget + optional fallback model — D42/D56) and
  optional `usage` telemetry. Opt-in Braintrust auto-instrumentation via `wrapOpenAI`.
- **Claude-Agent-SDK** (`src/adapters/claudecode/*`): mirrors the OpenRouter adapters but authenticates
  via a Claude Code subscription (no OpenRouter key); every role uses one `model`, `config.models` is
  ignored. Wired by `createClaudeCodeEngine` — **test/local only** (`npm run try:claude`).
- **Roles → models** are config-as-data (`config.models`: `plan`/`paint`/`critique`/`repair`),
  validated against `structuredOutputAllowlist` at load (`src/config/models.ts`, D11).
- **FileThemeRepository** loads `themes/<id>.theme.json` at runtime, **overriding** bundled presets by
  id; falls back to the bundle (`src/theme/presets/`) for ids not on disk. Themes: `botanical`, `bubblegum`.
- **NodeImageFetcher** resolves remote photo URLs → `data:` URIs; resilient (a failed URL is omitted,
  caller substitutes a placeholder) so generation never hard-fails on a flaky host.

## Adding a dependency

Add a **port interface** in `src/ports/`, a real adapter in `src/adapters/**`, a fake in
`src/testing/fakes/`, and wire both at the roots (`node-engine.ts` / `claudecode/engine.ts` /
`fakes/index.ts`). Never reach for a global clock/IO/randomness in the core.
