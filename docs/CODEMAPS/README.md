<!-- Generated: 2026-07-19 | Files scanned: 113 non-test src .ts (169 incl. tests) | Token estimate: ~320 -->

# Codemaps

Token-lean architecture maps for AI context loading. Generated from source — **regenerate, don't
hand-edit** (`/update-codemaps`). For prose rationale read `ARCHITECTURE.md` + `DECISIONS.md`
(now D1–D79).

| Map                                | Covers                                                             |
| ---------------------------------- | ------------------------------------------------------------------ |
| [architecture.md](architecture.md) | Project type, entry points, layering, composition roots, data flow  |
| [pipeline.md](pipeline.md)         | LangGraph nodes, node→port map, routing/termination, state channels |
| [ports.md](ports.md)               | Port ↔ real-adapter ↔ fake (the DI seam)                            |
| [qa.md](qa.md)                     | Two-tier QA checks, gate, scoring, repair, planning, config-as-data |
| [dependencies.md](dependencies.md) | External services, runtime deps, optional peers, build/gate         |

**Template note:** this is a stateless **library**, so the generic `backend.md`/`frontend.md`/
`data.md` codemaps don't apply — substituted with `pipeline.md` (the LangGraph "backend"), `ports.md`
(the DI seam), and `qa.md` (domain/data + correctness core). There is no frontend or database.

**Two paint paths** behind the one `Painter` port (D71): a theme declaring a `vocabulary` **composes**
(an LLM fills a small structured order; deterministic code renders it), everything else **free-paints**.
**5 of the 6 themes now compose** — `dhaba`, `bold-poster`, `blockframe`, `bazaar`, `bubblegum` — all built
on a shared toolbox (`src/vocabularies/shared/`: binding, carousels, registers, masthead, contract testkit;
D78); only `botanical` free-paints. Graph, packager, and QA are structurally unchanged — QA narrowly
**trusts** composed markup, keyed on a derived `data-composed` marker (D73/D76). See architecture.md (paths
+ roots), ports.md (`Composer`, `VocabularyRegistry`, `BrowserPort.measure`), qa.md (what the trust does and
does not skip).

**LLM backend:** `createNodeEngine` (OpenRouter) is the only one in the repo. A second backend,
`createClaudeCodeEngine` (Claude-Agent-SDK subscription auth), exists **only as untracked local files**
— `src/adapters/claudecode/**` and `scripts/try-claude.ts` are gitignored and eslint-ignored, so a
fresh clone has neither (the `try:claude` script in `package.json` is a dangling entry). Nothing tracked
imports it; it is free-paint only (no composer).
