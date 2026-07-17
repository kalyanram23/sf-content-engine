---
name: add-theme
description: Add a new digital-signage theme to content-engine end-to-end — theme JSON + composition vocabulary on the shared toolbox, with mockup and screenshot sign-off gates. Use when the user asks to add/create a new theme (e.g. "/add-theme", "add a retro diner theme").
---

# Add a new theme (composition path, D71/D78)

Produces a full composition theme: `themes/<id>.theme.json` + `src/vocabularies/<id>/index.ts` on
the shared toolbox (`src/vocabularies/shared/`), validated behind **two user sign-off gates** —
a mockup direction gate before any vocabulary code, and a rendered-screenshot gate before the
theme is wired in. Design source: `docs/superpowers/specs/2026-07-13-theme-vocabulary-migration-design.md`.

**Reference models** (register table → metric arithmetic → components → exported `ComponentVocabulary`):
- `src/vocabularies/bazaar/index.ts` + `src/vocabularies/blockframe/index.ts` — landscape body wrapped in ONE full-height panel (chrome subtracted in `contentBox`)
- `src/vocabularies/bold-poster/index.ts` — bare landscape body (plain page margins)
- `src/vocabularies/dhaba/index.ts` — the untouched legacy reference. Read it for mechanics history; **never copy its private helpers** (it keeps its own `esc`/`money`/binding copies on purpose) — always use the toolbox.

## Stage 1 — Interview (main session)

Ask 3–5 short questions, then confirm a one-line direction summary:
1. Theme name + id (kebab-case, becomes `themes/<id>.theme.json` and the vocabulary id).
2. Mood in one image ("like a 1970s diner placemat", "like a gig poster").
3. Color feel (light or dark board? loud or muted? one accent or two?).
4. Type feel (display face personality; body face legibility).
5. Photo treatment (framed cards? cutout stickers? polaroids? crossfade or filmstrip?).

## Stage 2 — Author the theme JSON

Write `themes/<id>.theme.json` — **WITHOUT the `vocabulary` field** (that is added last, in Stage 10,
after the screenshot gate). Shape (see `themes/bazaar.theme.json`):
`id, name, design {identity, do, dont}, tokens {colors, fontFamilies, radius}, motion, components, assets {backgrounds, fonts}`.

- **tokens.colors** — all nine keys: `bg, surface, surface-strong, text, muted, accent, accent-strong, price, sold`.
- **tokens.fontFamilies** — `display` and `body` stacks, first name single-quoted (e.g. `"'Anton', system-ui, sans-serif"`) — the embed script parses that first quoted name.
- **design.identity** — one paragraph like the existing themes: visual metaphor + type treatment + photo treatment + decoration policy (what furniture the theme may draw, what stays off-limits).
- **design.do / design.dont** — 4 each, theme-specific and enforceable (the critic sees them).
- **motion** — copy an existing theme's `motion` array as the baseline (e.g. bazaar's `fade-in` / `stagger-in` / `gallery-fade`).
- **components** — component recipes (masthead, price treatment, photo treatment, sold-tag…); every `binds` value must name a declared token — validated at load.
- **assets.fonts** — embed data-URIs: add any new family + weights to `FONT_SPECS` in `scripts/embed-fonts.ts`, then run
  `npm run embed:fonts -- <id>` (network needed once; result is committed). Same family at two weights MUST carry distinct `weight` fields.
- **WCAG check** — `text` on `bg` and `price` on `surface` must clear **4.5:1**. Quick check:
  ```bash
  npx tsx -e "import {contrastRatio} from './src/qa/contrast.ts';
  const rgb=(h:string)=>({r:parseInt(h.slice(1,3),16),g:parseInt(h.slice(3,5),16),b:parseInt(h.slice(5,7),16),a:1});
  console.log(contrastRatio(rgb('#1c1206'),rgb('#ff7215')))"
  ```

## Stage 3 — GATE 1: visual direction mockup

Build a **single-file HTML mockup** of one portrait board (1080×1920, a couple of sections + a
photo band) using the theme's real hex tokens and fonts. Show it to the user — via the superpowers
visual-companion server if available, else give the file path to open. Iterate until the user
**explicitly locks the direction. No vocabulary code before this gate passes.**

## Stage 4 — Build the vocabulary

Create `src/vocabularies/<id>/index.ts` on the shared toolbox. Imports:

```ts
import { bindPrice, bindRow, brandLogoPlaceholder, cardSlotAttr, esc, imgPlaceholder, money } from "../shared/binding";
import { crossfadeBand, filmstripBand, staticBand } from "../shared/carousels";
import { shrinkToFitPx } from "../shared/masthead";
import { metricsFromNumbers } from "../shared/registers";
```

**Engine-legal rules (QA punishes silently):**
- One root element with `data-composed="<id>@1"`; no document chrome (`<!DOCTYPE>`, `<link>`, `<script>`, `:root`).
- Tokens ONLY as `var(--color-*)` — no hex, no `rgba()`; low-alpha inks via `color-mix(in srgb, var(--color-text) 35%, transparent)`.
- Pure functions: no `Date`/`Math.random` — variation comes from section/card indices (e.g. tilt by `n % 2`).
- Every item row through `bindRow` (stamps `data-item-id`); every price through `bindPrice` with non-empty text (null price → "MP" on the same treatment); photos via `imgPlaceholder` (src-less); photo cards carry `cardSlotAttr(item)`; carousels ONLY via `crossfadeBand`/`filmstripBand`/`staticBand`.
- Masthead uses `shrinkToFitPx(title, basePx, baseChars, floorPx)` so long titles never wrap/clip.

**Layout numbers:**
- Register table `L/M/S`, largest first, as a `Record` of per-register px numbers; feed `metricsFromNumbers` in `metrics()`.
- **Density budget:** a 50-item section at S with 2 internal columns must be ≤ **0.92 × portrait `contentBox` height** — the testkit asserts this; do the arithmetic while choosing S sizes, don't discover it in Stage 7.
- `minStreamWidth: 420` (lets a packed 50-item landscape board escalate to a 4th column), `landscapeBannerHeight` ~210–230, `sectionGap` big enough to clear any shadow/tilt chrome between stacked sections.
- Photo cards: derive card width from photo height at a fixed per-register ratio (`w = Math.round(photoH * (r.cardW / r.cardPhotoH))` — blockframe pattern) so sparse-board band growth preserves aspect.
- **Landscape body:** if the identity forbids text on the ground color, wrap the landscape body in ONE full-height panel (bazaar/blockframe `renderShell`) and subtract its border + padding in `contentBox(landscape)`; keep the panel's shadow inside the page margins. Otherwise render it bare (bold-poster).
- Fill in `promptNotes` (`section`/`group`/`photoBand`) — one sentence each describing the theme's rendering of that kind (the composer reads these).

## Stage 5 — Tests

Create `src/vocabularies/<id>/<id>.test.ts`:

```ts
import { describeVocabularyContract } from "../shared/contract.testkit";
import { <camelId>Vocabulary } from "./index";
describeVocabularyContract(<camelId>Vocabulary);
```

…plus **5–10 theme-specific assertions** covering the theme's signature moves (shadow/tilt/pill/
border grammar, header shape, exact `contentBox` arithmetic, decoration counts). Model:
`src/vocabularies/bazaar/bazaar.test.ts`. Don't re-test what the testkit covers (list below).

## Stage 6 — Register

Add to `src/vocabularies/index.ts`: import the vocabulary and add it to the array in
`builtinVocabularies` (the map keys by `v.id`).

## Stage 7 — GATE: verify

```bash
npx prettier --write themes/<id>.theme.json src/vocabularies/<id>/ src/vocabularies/index.ts
npm run verify   # prettier --check → eslint → tsc --noEmit → vitest run — must be fully green
```

## Stage 8 — Density proof

```bash
npx playwright install chromium   # once per machine
npm run vocab:samples -- <id>     # six boards: 5/20/50 items × portrait/landscape
```

Zero `⚠` overflow warnings in the output. Then **Read every PNG** in `vocab-samples/<id>/` and
self-review: nothing clips at canvas edges, all chrome (shadows/tilt spill) inside the canvas,
captions legible, landscape columns balanced, photo cards not distorted. Fix and re-run until clean.

## Stage 9 — GATE 2: user sign-off

Show the user `vocab-samples/<id>/index.html` (contact sheet) or push the screenshots to the
visual companion. **Do NOT proceed without explicit approval** — this is the rendered-screenshot
gate from the design doc.

## Stage 10 — Wire + ship

1. Add `"vocabulary": "<id>"` to `themes/<id>.theme.json`, right after `id`.
2. `npm run verify` again — green.
3. Commit vocabulary + registry line + theme JSON **together** (one coherent change).

## What the contract testkit already enforces (don't re-test)

`describeVocabularyContract` (`src/vocabularies/shared/contract.testkit.ts`) asserts: sane registry
contract (ids, ≥2 unique registers, positive gaps/widths, promptNotes present); single
`data-composed="<id>@<version>"` root with no document chrome and token usage; brand-logo
placeholder (D18) and no real `<img src=`; **no raw hex anywhere**; `data-item-id` on every row and
non-empty `data-bind="price"` text (incl. MP); group coverage; src-less placeholders + shared slot
marker + reduced-motion settled frames in all three band modes; per-card slot escaping (QA-exact,
incl. quotes); flow lead/row/cue contracts; metric positivity/monotonicity across registers;
`photoBandCapacity` sanity; the 50-item @ S ≤ 0.92 × portrait box density budget; and ≥2 landscape
columns at `minStreamWidth`.

## Known pitfalls

- `parseOrThrow(schema, value, what)` is **3-arg** (`src/domain/parse.ts`).
- `exactOptionalPropertyTypes`: never pass `{ field: undefined }` — spread conditionally: `...(x !== undefined ? { field: x } : {})`.
- `verbatimModuleSyntax`: `import type` for type-only imports (eslint enforces).
- `noUncheckedIndexedAccess`: indexing returns `T | undefined` — guard or `!` where the invariant is real (e.g. `registerNames[0]!`).
- A formatter hook may rewrite files after your edits — **re-Read a file before re-Editing** it if an edit fails to match.
- The testkit's no-hex regex (`#[0-9a-fA-F]{3,8}\b`) also catches hex-looking **SVG ids/anchors** (e.g. `url(#fade)`, `id="abc123"`) — name SVG ids with non-hex characters.
- **Never hand-roll a carousel**: the toolbox bands ship the reduced-motion settled frame the QA browser depends on (`reducedMotion:"reduce"`); a hand-rolled crossfade screenshots as an EMPTY band.
- The engine draws landscape column dividers itself (a 2px low-alpha rule from the `text` token, `src/composition/renderer.ts`) — themes **cannot restyle them in v1**; don't emit your own.
- Declare row `line-height` inline on the row root so rendered heights match your metric estimates (the packaged root's preflight line-height would otherwise skew them).
- New font families must be added to `FONT_SPECS` in `scripts/embed-fonts.ts` first, or the script falls back to a plain regular fetch with a warning (wrong weight).

## Delegation

Kal's preference: the main session runs the **interview, both gates, PNG review sign-off relay,
and commits**. Delegate the heavy build — **Stages 4–8** — to one general-purpose subagent with a
precise brief: the locked direction summary, the theme JSON path, the visual mapping (per-kind
rendering language, like the design doc's per-theme mapping section), which landscape pattern to
use, the toolbox import list, the density budget, and the requirement to end with `npm run verify`
green + `vocab:samples` clean. Review its diff before Stage 9.
