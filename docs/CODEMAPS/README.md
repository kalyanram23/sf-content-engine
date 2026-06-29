<!-- Generated: 2026-06-28 | Files scanned: 70 src .ts | Token estimate: ~250 -->

# Codemaps

Token-lean architecture maps for AI context loading. Generated from source — **regenerate, don't
hand-edit** (`/update-codemaps`). For prose rationale read `ARCHITECTURE.md` + `DECISIONS.md`.

| Map                                | Covers                                                       |
| ---------------------------------- | ----------------------------------------------------------- |
| [architecture.md](architecture.md) | Project type, entry points, layering, composition roots, data flow |
| [pipeline.md](pipeline.md)         | LangGraph nodes, node→port map, routing/termination, state channels |
| [ports.md](ports.md)               | Port ↔ real-adapter ↔ fake (the DI seam)                    |
| [qa.md](qa.md)                     | Two-tier QA checks, scoring, repair, planning/coverage, config-as-data |
| [dependencies.md](dependencies.md) | External services, runtime deps, optional peers, build/gate |

**Template note:** this is a stateless **library**, so the generic `backend.md`/`frontend.md`/
`data.md` codemaps don't apply — substituted with `pipeline.md` (the LangGraph "backend"), `ports.md`
(the DI seam), and `qa.md` (domain/data + correctness core). There is no frontend or database.
