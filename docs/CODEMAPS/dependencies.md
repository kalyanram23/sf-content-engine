<!-- Generated: 2026-07-12 | Files scanned: package.json + .env.example + eslint/vitest/tsup configs + src/adapters/** + src/config/models.ts | Token estimate: ~780 -->

# Dependencies

## External services (production, via Node adapters only)

```
OpenRouter (LLM gateway)   5 roles: plan · paint · critique · repair · compose   src/adapters/openrouter/*
  auth: OPENROUTER_API_KEY ; attribution: OPENROUTER_APP_URL / _NAME
  compose = the composition order form (D71) → openrouter/composer.ts, alongside planner/painter/
    vision-critic/repairer. Per-role: reasoning · maxTokens · resilience (retry) · fallback model ·
    requestTimeoutMs (300s) / fallbackRequestTimeoutMs (900s) — all src/config/models.ts.
  structuredOutputAllowlist is enforced at config load for plan/critique/repair/compose (D11);
    `paint` is exempt (returns free HTML).  src/config/index.ts: STRUCTURED_OUTPUT_ROLES
Headless Chromium          render + screenshot for deterministic QA   src/adapters/playwright/browser.ts
  needs: npx playwright install chromium ; live test gated by RUN_BROWSER_TESTS=1
Remote image hosts         item photos → data: URIs (offline-safe)    src/adapters/image/image-fetcher.ts
  brand logo (url | fs path | data:) → data: URI              src/adapters/image/asset-resolver.ts
  both use global fetch (Node ≥18) — no HTTP dep
```

Shelved: `src/adapters/claudecode/**` + `scripts/try-claude.ts` (`npm run try:claude`) — a
Claude-Agent-SDK LLM backend, kept on disk but **gitignored and out of the gate** (eslint `ignores`).
No composer there; composition is OpenRouter-only.

No database, no cache, no message queue — the engine is stateless across calls (D15).

## Runtime dependencies (core, always installed)

```
@langchain/langgraph  ^1.4.5   StateGraph QA loop — isolated to src/pipeline/graph.ts only
@langchain/core       ^1.2.1   graph primitives
zod                   ^4.4.3   all schemas/contracts; z.toJSONSchema, .prefault({})
node-html-parser      ^8.0.3   structural QA checks parse HTML
braintrust           ^3.20.0   OPT-IN LLM tracing: createNodeEngine({ braintrust }) → initLogger
                               (node-engine.ts) + wrapOpenAI (openrouter/client.ts). Omitted =
                               never initialized; default tracing is OpenRouter Broadcast
                               (session_id + trace), no extra dep.
zod-to-json-schema   ^3.25.2   VESTIGIAL — not imported anywhere in src/ or scripts/ (Zod 4's
                               built-in z.toJSONSchema replaced it); still pulled in transitively
                               by @langchain/*.
```

## Optional peers (Node entry only — hermetic boundary, eslint-enforced)

```
openai            ^6.44.0   OpenRouter-compatible client   } no-restricted-imports: importable
playwright-core   ^1.61.0   headless browser               } ONLY from src/node.ts and
tailwindcss        ^4.3.1   utility CSS compile            } src/adapters/**
@tailwindcss/node  ^4.3.1   programmatic Tailwind build    } (all peerDependenciesMeta: optional)
```

Same rule also bans `motion` outside the build script, and bans `**/adapters/**` imports from the
core. The main `.` entry never imports these — a service can `import type` from `content-engine` in
RSC code with zero runtime cost. `src/index.ts` must have **no import side effects**.

## Dev/test-only

```
@anthropic-ai/claude-agent-sdk  ^0.3.196   backend for the shelved claudecode adapters
motion                           12.41.0   source for the baked motion bundle
                                           (build:motion → adapters/tailwind/motion-bundle.generated.ts)
```

## Build-time

```
tsup ^8.5.1    ESM only, target node20, dts, 3 entries: index (src/index.ts) · node (src/node.ts)
               · testing (src/testing.ts); externals = openai, playwright(-core), tailwindcss,
               @tailwindcss/node. Motion bundle baked by `prebuild`.  esbuild pinned 0.27.7
tsx ^4.22.4    scripts/*: regen:samples, try, try:claude, embed:fonts, build:motion,
               build:full-plan, eval; plus playground
vitest ^4.1.9  default (vitest.config.ts): src/**/*.test.ts, EXCLUDES *.live.test.ts → hermetic,
               fakes only.  gated (vitest.live.config.ts): only src/**/*.live.test.ts, 120s
               timeouts, process.loadEnvFile() reads .env → `npm run test:live`
eslint · prettier · typescript ^6 (strict: verbatimModuleSyntax, exactOptionalPropertyTypes,
                                   noPropertyAccessFromIndexSignature)
```

## Env surface (.env.example — 4 vars, none needed by the hermetic suite)

```
OPENROUTER_API_KEY   required for any real LLM call / the OpenRouter live test
OPENROUTER_APP_URL   optional attribution header
OPENROUTER_APP_NAME  optional attribution header
RUN_BROWSER_TESTS=1  enables the live Playwright test
```

Model routing is **NOT env** — it's config-as-data (`createNodeEngine({ config: { models: … } })`,
defaults in `src/config/models.ts`).

Gate: `npm run verify` = prettier --check → eslint → tsc --noEmit → vitest run.
Engine requires Node >= 20 (`engines`); live `.env` loading via `--env-file` needs 22+.
