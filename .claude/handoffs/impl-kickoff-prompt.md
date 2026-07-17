# Kickoff prompt for the implementation session (copy everything below the line)

---

Execute the approved menu-cast ↔ content-engine integration plans. You are the ORCHESTRATOR
(Fable) — you dispatch and review; subagents implement. Use
superpowers:subagent-driven-development: one fresh subagent per plan task, review gate between
tasks.

**Model routing for subagents:** Opus for anything touching engine QA/composition/vocabularies,
the worker orchestrator, sync/route rewiring, and ALL review gates; Sonnet for mechanical tasks
(scaffolds, Dockerfile, config plumbing, test-only tasks). You (Fable) never implement directly.

**Read before dispatching anything, in this order:**
1. The spec: `docs/superpowers/specs/2026-07-13-menucast-integration-design.md` (same file exists
   in both repos).
2. Plan A: `/Users/kal/dev/rest/content-engine/docs/superpowers/plans/2026-07-16-menucast-integration-A-engine.md`
3. Plan B: `/Users/kal/dev/rest/menu-cast/docs/superpowers/plans/2026-07-16-menucast-integration-B-worker.md`
4. Plan C: `/Users/kal/dev/rest/menu-cast/docs/superpowers/plans/2026-07-16-menucast-integration-C-serving.md`
5. Each repo's CLAUDE.md before working in it.

**Execution order and hard rules:**
- Plan A first, in content-engine, on a branch `feat/menucast-a` off main. Gate every task with
  `npm run verify`. When A is done: merge to main per the repo's finishing flow, then tag
  `menucast-a-complete` (Plan A Task A7 Step 4) — Plan B's worker pins that tag.
- Then Plan B, then Plan C tasks C1–C6, in menu-cast. Task B0 creates the work branch
  `feat/engine-bakes` off `feat/llm-2.0` (after absorbing main's three fixes INTO the branch) and
  tags `engine-bakes-baseline`. **NEVER merge feat/llm-2.0 or feat/engine-bakes into main** — the
  only merge to main is the human-gated one inside Task C8, which does NOT run in this session.
- Plans are the source of truth for every task's files/steps/tests; where a plan says
  "verify/locate first", do that before writing code. Follow TDD exactly as written (failing test
  → implement → pass → commit).
- Verified-drift rule: if a file a plan references doesn't match reality, stop that task, note the
  drift, adapt minimally, and record the deviation in the task's commit message.
- STOP points requiring Kal: Plan C Task C7 (dev deploy + Fire TV hardware checks) and everything
  in C8. When you reach C7, summarize state and hand back.
- If context runs long: commit everything green, update the session bookmark memory, and tell Kal
  to resume with a fresh session pointing at the plans + progress ledger.

Track progress with the task tools (one task per plan task). Start by reading the spec and Plan A,
then dispatch A1.
