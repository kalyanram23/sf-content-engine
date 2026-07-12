<!-- Generated: 2026-07-11 | Files scanned: package.json + src/adapters/** | Token estimate: ~680 -->

# Dependencies

## External services (production, via Node adapters only)

```
OpenRouter (LLM gateway)   plan · paint · critique · repair roles   src/adapters/openrouter/*
  auth: OPENROUTER_API_KEY ; attribution: OPENROUTER_APP_URL / _NAME ; per-role retry + fallback model
Claude-Agent-SDK backend   same 4 LLM roles, subscription auth      src/adapters/claudecode/*
  TEST/LOCAL ONLY (createClaudeCodeEngine, npm run try:claude) — no OpenRouter key; one `model` per run
Headless Chromium          render + screenshot for deterministic QA  src/adapters/playwright/browser.ts
  needs: npx playwright install chromium ; live test gated by RUN_BROWSER_TESTS=1
Remote image hosts         item photos → data: URIs (offline-safe)   src/adapters/image/image-fetcher.ts
```

No database, no cache, no message queue — the engine is stateless across calls (D15).

## Runtime dependencies (core, always installed)

```
@langchain/langgraph   StateGraph QA loop — isolated to src/pipeline/graph.ts only
@langchain/core        graph primitives
zod (v4)               all schemas/contracts; z.toJSONSchema, .prefault({})
zod-to-json-schema     strict JSON schema for LLM structured output
node-html-parser       structural QA checks parse packaged HTML
braintrust             OPT-IN LLM tracing (createNodeEngine({ braintrust })); default path is
                       OpenRouter Broadcast (session_id + trace), no logger needed
```

## Optional peers (Node entry only — hermetic boundary, eslint-enforced)

```
openai                 OpenRouter-compatible client    } importable ONLY from
playwright-core        headless browser                } src/node.ts and
tailwindcss            utility CSS compile              } src/adapters/**
@tailwindcss/node      programmatic Tailwind build      } (peerDependenciesMeta: optional)
```

The main `.` entry never imports these — a service can `import type` from `content-engine` in RSC
code with zero runtime cost. `src/index.ts` must have **no import side effects**.

## Dev/test-only

```
@anthropic-ai/claude-agent-sdk   the Claude-Code subscription LLM backend (claudecode adapters)
motion                           source for the baked motion bundle (build:motion → generated.ts)
```

## Build-time

```
tsup      ESM + .d.ts for the 3 entries          motion bundle baked by prebuild
tsx       run scripts/* (regen samples, try, try:claude, embed fonts, build motion/full-plan, evals)
vitest    hermetic suite (fakes) + gated *.live.test.ts (vitest.live.config.ts)
eslint · prettier · typescript (strict: verbatimModuleSyntax, exactOptionalPropertyTypes,
                                noPropertyAccessFromIndexSignature)
```

Gate: `npm run verify` = prettier --check → eslint → tsc --noEmit → vitest run.
Engine requires Node >= 20 (live `.env` loading via `--env-file` needs 22+).
