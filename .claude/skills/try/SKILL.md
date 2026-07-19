---
name: try
description: Use when running or asked to run the generation pipeline — "run it", "try the full menu", "generate the screens", a theme/preset test, or when a pipeline run failed, hung, or produced bad output.
---

# Try (pipeline run + diagnose)

## Overview

Runs the screen-generation pipeline and owns the outcome: Kal should never have to Ctrl-C a
hung run and paste a stack trace. The run is yours — watch it, diagnose it, summarize it.

## Command

```bash
npm run try -- samples/<menu>.json [--screens=6] [--aspect=16:9|9:16] [--preset=<theme>] \
  [--screens-mode=elastic] [--parallel=N] [--prompt "<creative instruction>"] [--fresh] [--verbose]
```

- Default theme is `bubblegum`; default aspect 16:9; `--fresh` wipes `real-output/` and
  replans everything — default RESUMES a previous run (cheaper, reuses finished boards).
- Confirm the two things Kal habitually leaves out **before** launching: screen count and
  aspect ratio (only ask if not stated and not obvious from context).

## Run discipline

1. Launch **in the background** (runs take 2–15+ minutes) and monitor — never block the
   session waiting, never make Kal watch it.
2. On progress: report stage transitions briefly (plan → paint board N/M → QA), not raw logs.
3. On completion: state where output landed (`real-output/`, `debug/screen-N/`), how many
   boards rendered, and anything the QA critic flagged — in plain product language.
4. **On failure or hang: diagnose before reporting.** Read the stack/last log lines from the
   run and `debug/`, identify the failing stage and likely cause, and present: what broke,
   where, proposed fix. Never just relay a raw stack trace back to Kal.
5. If the same run fails twice the same way, stop rerunning and switch to systematic
   debugging of the root cause.

## Common mistakes

- Rerunning with `--fresh` by reflex — it throws away resumable finished boards; resume is
  the default for a reason.
- Reporting "it's running" with no follow-through — own the run to its end state.
