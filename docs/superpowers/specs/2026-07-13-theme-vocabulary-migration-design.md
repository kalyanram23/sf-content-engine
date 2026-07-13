# Theme migration to the composition paint path (D71) + add-theme skill — design

**Date:** 2026-07-13
**Status:** approved (brainstormed with Kal; plan approved same day)

## Problem

Only `dhaba` has a composition package (`ComponentVocabulary`), so every other theme pays free-paint
prices on every board: minutes of LLM generation, a multi-iteration critic loop, and run-to-run
variance even though each theme's look is settled. Kal wants **bazaar, blockframe, bold-poster and
bubblegum** migrated to the composition path, **botanical kept free-paint** (it remains the live
coverage for that path), and a repeatable, prompt-driven way to add future themes. Boards must
handle **5–50 items per screen**.

## Decisions

1. **Per-theme visual sign-off.** Dhaba's vocabulary was mined from a hand-validated gold board;
   these four themes have no gold boards — only their free-paint identity text and tokens. So each
   theme's look is validated in two gates: a browser **mockup direction gate** before its vocabulary
   is written, and a **rendered-screenshot gate** (real `renderComposed` output at 5/20/50 items,
   portrait + landscape) before the theme JSON is switched over.

2. **B-lite architecture: shared toolbox, dhaba untouched.** The engine-coupled machinery in a
   vocabulary is fragile in ways QA punishes silently (attribute escaping must match
   `escapeSlotTitle` in `src/qa/structural-checks.ts` byte-for-byte; carousels need a
   reduced-motion settled frame or QA screenshots blank bands; rows must stamp exact
   `data-item-id`/`data-bind` markers). That machinery is extracted **once** into
   `src/vocabularies/shared/` and the four new themes build on it — but **dhaba's module is left
   exactly as it is**, serving as the known-good reference to diff against when a toolbox theme
   misbehaves. A sync *test* (touching no dhaba code) pins the toolbox's escaping/markers to
   dhaba's rendered output and the QA matcher's expectations, so the two copies can't drift
   silently. Rationale for not refactoring dhaba now: Kal explicitly prefers a working reference
   implementation over one pattern everywhere; a later cleanup can fold dhaba onto the toolbox.

3. **The add-theme skill produces full composition themes.** Interview → theme JSON → mockup
   direction gate → vocabulary on the toolbox + contract tests → density renders → visual sign-off
   → wire-in. No JSON-only fast path.

4. **Toolbox owns mechanics only.** Colors, borders, shadows, card layout — always in the theme's
   own module. The kit provides: binding/escaping helpers, carousel mechanics (crossfade +
   filmstrip factories over a `renderCard` callback), register-table→`VocabularyMetrics` math,
   masthead shrink-to-fit, and `describeVocabularyContract(vocab)` — a reusable test suite any
   vocabulary (including skill-generated ones) must pass.

## Per-theme visual mapping

Every vocabulary renders the same abstract kinds — shell, section, group, photoBand, landscape flow
pieces — in the theme's language (from each theme's `design.identity` + `do`/`dont`):

- **bold-poster** — cream editorial page; huge tilted Shrikhand masthead with rules + corner crop
  marks; red letterspaced kickers above section headlines; thin ink rules; bold deep-red price
  numerals after dotted leaders; photos as thin-ruled "cover shots" on tan panels; flat (no
  shadows). Filmstrip default.
- **blockframe** — warm paper; white cards with thick ink borders + hard offset shadows;
  candy-yellow bordered section-header bands; Space Grotesk rows, square corners; photos framed in
  bordered blocks with solid caption panels; sparse geometric margin marks. Filmstrip default.
- **bazaar** — hot-orange ground; each section a cream panel (thick ink border, hard offset shadow,
  ≤1.5° tilt — body text never tilts); Anton all-caps headers with a short red underline; dotted
  leaders into bordered price chips; photo band = **circle-sticker strip** (cutout circles with
  cream border, ink outline, hard shadow). This adapts the identity's "one sticker overlapping each
  section's panel" to the engine's shared-band contract — per-section slot coverage is already
  guaranteed by `resolveCollage` (D75), so each section that planned a photo gets its sticker in
  the strip. Filmstrip default.
- **bubblegum** — deep grape stage with a subtle film-grain overlay in the shell; big rounded
  glossy "sticker" section cards with the accent rotating coral→mint→yellow per section
  (deterministic: section index mod 3); near-white Inter rows, sunny-yellow prices; sparkle/dot
  dividers; **crossfade** photo default per its identity. The identity's hue-drift-during-carousel
  is **out of v1**: it fights the settled-frame QA rule (a screenshot must represent the live
  board).

Landscape for all four uses the engine's existing newspaper-column flow; themes only style dividers
and the "(cont.)" continuation cue.

## Density guarantee (5–50 items/screen)

The generic layout engine already scales via register search × internal price columns (1–3) ×
landscape columns. Each theme ships a register table (L/M/S) whose smallest register fits a 50-item
section in the portrait content box with internal columns (dhaba's math: ~500px of ~1740px — the
target each new table must meet). Proven per theme by `npm run vocab:samples` renders at 5/20/50
items in both orientations — the same screenshots Kal approves.

## Out of scope

- Refactoring dhaba onto the toolbox (deliberate, see decision 2).
- Botanical migration (stays free-paint by request).
- Bubblegum hue-drift carousel (v2 candidate, needs a QA-representable form).
- Any engine/graph/QA/config change — the composition layer is already theme-agnostic; migration
  touches only `src/vocabularies/`, `themes/*.theme.json` (one field), the registry line, scripts,
  and docs.

## Delivery

Toolbox first, then one theme at a time — bold-poster (pilot; closest to dhaba's paper-poster
feel), blockframe, bazaar, bubblegum — each behind its two gates, `npm run verify` green after
every stage. Then the `add-theme` project skill (`.claude/skills/add-theme/`) encoding the same
workflow, and a D78 entry in `DECISIONS.md`.
