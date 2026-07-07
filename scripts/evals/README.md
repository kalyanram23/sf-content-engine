# Evals — measuring whether the engine is actually good

Unit tests check that the _code_ works. **Evals check that the _product_ is good**: when the
real LLMs plan and paint real menus, do the finished boards come out right — and how often?
Because LLM output varies run to run, an eval is not "does it work once" but "out of N
realistic jobs, how many come out shippable, at what cost, and what goes wrong when it fails."

## How to run

```bash
npm run eval                              # full suite (real LLM calls — costs real money)
npm run eval -- --case=tiny-menu          # one scenario
npm run eval -- --fresh                   # redo everything (default: resume finished boards)
npm run eval -- --fresh --case=tiny-menu  # redo ONLY tiny-menu, leave every other case cached
npm run eval -- --no-judge                # skip the independent vision judge
npm run eval -- --out=eval-output-run2    # a second run for comparing stability
npm run eval -- --help                    # list every flag
```

Needs `OPENROUTER_API_KEY` in `.env` and the Playwright browser
(`npx playwright install chromium`, one-time). Results land in `eval-output/`:
a human-readable **`scorecard.md`**, a machine-readable `summary.json`, and per-board
HTML / poster PNG / QA report files you can open and eyeball.

## How fast — and how hard to push it

A full serial run takes **hours**: every board is a real generate() call and a single paint
averages ~3 minutes, with the biggest scenario (`full-menu`) spanning 6 boards. The runner is
concurrent by default to cut that down:

```bash
npm run eval                              # default: up to 3 cases × 2 boards in flight
npm run eval -- --parallel=1              # fully serial (the old behavior — easiest to read)
npm run eval -- --parallel=5              # more cases at once (watch your rate limits)
npm run eval -- --board-parallel=1        # one board at a time inside each case
```

- **`--parallel=N`** (default `3`) — how many scenarios run concurrently.
- **`--board-parallel=M`** (default `2`) — how many boards of the _same_ scenario run at once.

Resume is unchanged: a board whose `<screen>.board.json` already exists is reused, never re-run
(use `--fresh` to force). **`--fresh` is scoped by `--case`:** on its own it wipes the whole
`--out` dir for a clean-slate suite run; combined with `--case=<id,…>` it deletes only those
cases' subdirectories, so a targeted redo never throws away every other case's cached output.
When more than one case runs at a time, every log line is prefixed with
its case id (e.g. `[photo-heavy] board 2/2 …`) so interleaved output stays readable. The scorecard
and `summary.json` are still written in case order regardless of who finishes first.

Parallelism does **not** change total cost — it changes the **burn rate**: the same tokens are
spent in a shorter window, i.e. more tokens (and more transient Chromium instances) per minute. The
defaults (3 × 2 ≈ up to 6 concurrent renders) are deliberately modest to stay under OpenRouter's
per-key **rate limits** (429s / throttling) and local resource limits; raise `--parallel` only if
you know you have the headroom, and expect diminishing returns once you hit the provider's ceiling.

### Iteration recipe

For a fast dev loop, use the **smoke tier** — the three cheapest scenarios that still cover the
distinct failure classes (`tiny-menu`, `sparse-board`, `portrait`; marked `smoke: true` in
`cases.ts`):

```bash
npm run eval -- --smoke --out=eval-smoke   # fast loop: ≈4 boards, minutes not hours
npm run eval                               # full suite — release validation
```

It composes with `--no-judge` for an even cheaper structural-checks-only loop, and with
`--case=` to narrow further. Resume applies within an output dir as before: re-running with the
same `--out` skips already-finished boards (use `--fresh` to force a redo).

Seven frozen jobs, each probing a different way the pipeline could fail:

| Scenario       | Probes                                                     |
| -------------- | ---------------------------------------------------------- |
| `tiny-menu`    | 5 items with sizes/variants — price-table handling         |
| `sparse-board` | 3 items on one board — screens that risk looking empty     |
| `photo-heavy`  | ~28 items, mostly with photos — image layout and cropping  |
| `text-only`    | ~26 items, zero photos — typography has to carry the board |
| `portrait`     | vertical 9:16 screens                                      |
| `long-text`    | very long dish names/descriptions — overflow stress        |
| `full-menu`    | the real job: 241 items / 31 categories across 6 boards    |

The suite is **frozen on purpose** — same inputs every run, so two runs are comparable and a
change to prompts/models/config shows up as a score change, not noise. Add new scenarios
rather than editing existing ones.

Each case's `restaurant` name is passed to the engine as the run **brand** (`brand: { name }`),
so the real name renders in every board's masthead band — the painter no longer has to invent a
fake establishment name to fill that slot, and the masthead is identical across a scenario's boards.

## How boards are graded (`graders.ts`)

Three layers, most trustworthy first:

1. **Bookkeeping guarantees** — objective code checks that must _always_ pass:
   every menu item appears on exactly one board, no category is split across boards,
   the asked-for board count is honored, every planned item is really in the shipped HTML,
   and the HTML loads nothing from the network. A single failure here is a bug, not taste.
2. **The engine's own QA verdict** — did the board pass the built-in generator–critic loop,
   in how many tries, and with which findings left when it shipped.
3. **An independent judge** — a _different_ vision model (Claude Opus, not the in-loop critic)
   looks at each finished poster and answers one binary question: would a picky restaurant
   owner put this on their TV today, ship or reject? This guards against the engine grading
   its own homework, and the judge-vs-QA agreement rate tells us how trustworthy the in-loop
   critic is.

Per board we also record retries used, wall-clock time, tokens per model role, and an
estimated dollar cost (priced live from OpenRouter's public model list).

## Reading the scorecard

- **Bookkeeping guarantees** table — anything below 100% is a straight bug to fix.
- **QA pass rate** — how often boards converge inside the retry budget. Boards marked
  `flagged` shipped as "best effort" after the budget ran out.
- **Judge ship rate** — the closest thing to "a human would accept this". If QA passes but
  the judge rejects, the in-loop critic is too lenient (or the rubric misses something);
  if QA fails but the judge ships, the critic is too strict and is burning retries.
- **What went wrong** — findings clustered by kind across all boards; the top rows are the
  highest-leverage things to improve next.

There is no long history yet — treat the first run as the **baseline** and compare every
later run (after a prompt, model, or config change) against it.
