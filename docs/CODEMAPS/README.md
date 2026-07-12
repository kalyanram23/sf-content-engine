<!-- Generated: 2026-07-11 | Files scanned: 86 non-test src .ts (128 incl. tests) | Token estimate: ~280 -->

# Codemaps

Token-lean architecture maps for AI context loading. Generated from source — **regenerate, don't
hand-edit** (`/update-codemaps`). For prose rationale read `ARCHITECTURE.md` + `DECISIONS.md`
(now D1–D70).

| Map                                | Covers                                                       |
| ---------------------------------- | ----------------------------------------------------------- |
| [architecture.md](architecture.md) | Project type, entry points, layering, composition roots, data flow |
| [pipeline.md](pipeline.md)         | LangGraph nodes, node→port map, routing/termination, state channels |
| [ports.md](ports.md)               | Port ↔ real-adapter ↔ fake (the DI seam)                    |
| [qa.md](qa.md)                     | Two-tier QA checks, gate, scoring, repair, planning, config-as-data |
| [dependencies.md](dependencies.md) | External services, runtime deps, optional peers, build/gate |

**Template note:** this is a stateless **library**, so the generic `backend.md`/`frontend.md`/
`data.md` codemaps don't apply — substituted with `pipeline.md` (the LangGraph "backend"), `ports.md`
(the DI seam), and `qa.md` (domain/data + correctness core). There is no frontend or database.

**Two real LLM backends** now exist behind the ports: `createNodeEngine` (OpenRouter, production) and
`createClaudeCodeEngine` (Claude-Agent-SDK subscription auth, **test/local only**) — see architecture.md.
