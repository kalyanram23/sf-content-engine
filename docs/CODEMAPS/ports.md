<!-- Generated: 2026-06-28 | Files scanned: src/ports/** src/adapters/** src/testing/fakes/** | Token estimate: ~700 -->

# Ports & Adapters (the DI seam)

`EnginePorts` (`src/ports/index.ts`) is everything the pure core depends on; constructed only at a
composition root. `logger`, `debug`, `llmRepairer` are **optional** (deterministic repairs are
pure-core — D13).

## Port → real adapter → fake

```
port (interface)        real adapter (src/adapters/**)            fake (src/testing/fakes/**)
─────────────────────── ───────────────────────────────────────  ──────────────────────────
Planner.plan            openrouter/planner OpenRouterPlanner      fakes/planner
                        planner/static-planner StaticPlanner        (StaticPlanner if plan given)
ThemeRepository.get     theme/file-theme-repository FileThemeRepo  theme/presets InMemoryThemeRepo
ImageFetcher.fetch      image/image-fetcher NodeImageFetcher       (inline/no-op)
Painter.paint           openrouter/painter OpenRouterPainter       fakes/painter (valid HTML)
Packager.package        tailwind/packager TailwindPackager         fakes/packager
BrowserPort.render      playwright/browser PlaywrightBrowser       fakes/browser ScriptedBrowser
VisionCritic.critique   openrouter/vision-critic OpenRouterVision  fakes/vision-critic Scripted…
LlmRepairer.repair      openrouter/repairer OpenRouterRepairer     (optional; omitted)
Clock.now               node-engine SystemClock                    fakes/services (fixed)
IdGenerator.next        node-engine SystemIdGenerator              fakes/services (counter)
Logger (optional)       caller-supplied                           caller-supplied
DebugSink (optional)    caller-supplied (per-iteration capture)    —
```

## Adapter notes

- **OpenRouter** (`src/adapters/openrouter/client.ts`): one shared client; `requestStructured`
  (strict JSON schema, D11) + `requestText`. Painter/planner/critic/repairer wrap it per role.
- **Roles → models** are config-as-data (`config.models`: `plan`/`paint`/`critique`/`repair`),
  validated against `structuredOutputAllowlist` at load (`src/config/models.ts`, D11).
- **FileThemeRepository** loads `themes/<id>.theme.json` at runtime, **overriding** bundled presets
  by id; falls back to the bundle (`src/theme/presets/`) for ids not on disk. Themes:
  `botanical`, `bubblegum`.
- **NodeImageFetcher** resolves remote photo URLs → `data:` URIs; resilient (a failed URL is
  omitted, caller substitutes a placeholder) so generation never hard-fails on a flaky host.

## Adding a dependency

Add a **port interface** in `src/ports/`, a real adapter in `src/adapters/**`, a fake in
`src/testing/fakes/`, and wire both at the roots (`node-engine.ts` / `fakes/index.ts`). Never reach
for a global clock/IO/randomness in the core.
