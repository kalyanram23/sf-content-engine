# Painter-authored decoration (remove static theme SVG)

**Date:** 2026-06-27
**Status:** Design approved, pending spec review
**Area:** theme assets · painter prompt/contract · token-lint QA

## Problem

The botanical theme ships a hand-authored SVG leaf pattern as a vetted asset
(`themes/botanical.theme.json` → `assets.backgrounds[0]`, id `botanical-leaves`). At package
time the Tailwind packager injects it as a static `body { background-image: url(<dataUri>) }`
(`src/adapters/tailwind/packager.ts` `baseStyles`; mirrored in the fake packager). The painter
never sees it and never influences it — it is the same wallpaper on every screen regardless of
the menu content.

We do not want a static, context-blind SVG. The painter (an LLM that already has the full theme,
tokens, motion vocabulary, plan, and items) should author the decoration itself, on the fly, so
it is designed for *this* screen and **adds value as a menu screen** — not just a tiled backdrop.

## Goal

Replace the static botanical background asset with painter-authored decoration that plays two
roles, at the painter's discretion given the menu content:

1. **Ambient backdrop** — an authored full-bleed decorative layer (organic leaf/branch line-art,
   soft botanical forms) in the theme palette, sitting behind content.
2. **Integrated decoration** — purposeful accents that earn their place in the composition:
   header flourishes, section dividers, small leaf motifs beside titles, an illustrative
   botanical motif for items that have no photo.

All decoration must stay on the existing engine rails: theme tokens only (no raw hex), offline /
self-contained, never harm text contrast, never overflow 1920×1080.

## Non-goals

- Removing the `assets.backgrounds` capability from the schema. It stays (defaulted `[]`); other
  themes may still ship a vetted background if they choose. We only empty botanical's.
- Touching embedded **fonts**. Fonts remain inlined data-URIs — they must be self-contained for
  offline rendering. Only the decorative SVG is removed.
- Changing the packager's `baseStyles` logic. It already no-ops the `background-image` when
  `backgrounds` is empty (`const bg = theme.assets.backgrounds[0]?.dataUri`), in both the real and
  fake packagers. No code change needed there.

## Architecture fit

Preserves the existing split (CLAUDE.md / `ARCHITECTURE.md`): **themes own the creative prompt;
the engine owns the technical rails.**

- *What to draw* (botanical leaves, where accents help) → theme-owned, lives in the theme's
  `prompt` in `themes/botanical.theme.json`.
- *How decoration must behave* (tokens, contrast, offline, fit, a11y) → engine-owned, lives in
  `ENGINE_CONTRACT` in `src/adapters/openrouter/painter.ts`, so it holds for any theme that
  invites decoration.

## Changes

### 1. `themes/botanical.theme.json`
- Set `assets.backgrounds` to `[]` (remove the `botanical-leaves` entry). Keep `assets.fonts`.
- Extend the theme `prompt` with botanical decoration direction: the painter should author its
  own decoration — an ambient botanical backdrop **and** integrated accents (header/section
  flourishes, leaf motifs beside titles, an illustrative motif for photo-less items) — tasteful
  and subtle, using the olive/sage palette, so it elevates the menu rather than cluttering it.

### 2. `src/adapters/openrouter/painter.ts` — `ENGINE_CONTRACT` DECORATION rail (engine-general)
Add a bullet block stating the painter MAY add inline decorative SVG/CSS, subject to:
- **Inline only** — no external URLs (reaffirms the self-contained rule).
- **Theme tokens only** — fills/strokes use `fill="var(--color-accent)"` / `stroke="var(--color-…)"`
  or `currentColor` + a token text class. **Never raw hex.**
- **Ambient / secondary** — decoration sits *behind* content (low opacity / negative z-index / in
  the margins) and must never reduce text contrast; text stays on solid theme surfaces.
- **Safe** — purely decorative SVG is `aria-hidden="true"`; decoration never overflows 1920×1080
  or pushes content out of frame.

### 3. `src/qa/structural-checks.ts` — token-lint hardening
Today `checkTokenLint` scans class arbitrary-values, inline `style`, and `<style>` blocks for raw
hex/px — but **not** SVG presentation attributes. Now that we invite inline SVG, extend it to also
scan the SVG colour attributes `fill`, `stroke`, `stop-color`, `flood-color` for raw hex (reusing
`lintCss`/`HEX`). Off-theme hex in decoration then surfaces as a `TokenLint` major finding and the
QA loop re-paints, keeping decoration provably on-theme. (px is not meaningful on these attributes,
so hex only.)

### 4. Tests + gate
- `src/qa/structural-checks.test.ts`: add cases — `<svg><path fill="#abcdef"/></svg>` and
  `stroke="#fff"` trip token-lint; `fill="var(--color-accent)"` and `fill="currentColor"` pass.
- Confirm no existing test depends on botanical shipping a background (verified: none do;
  `repairs.test.ts` and `structural-checks.test.ts` already use `backgrounds: []`).
- Finish with `npm run verify` (prettier → eslint → tsc → vitest).

## Risk / rollback

- Low blast radius: schema unchanged, packager unchanged, fonts unchanged. The behavioural change
  is entirely in prompt text + one additive QA scan.
- The token-lint extension could trip on legitimate decoration if the painter ignores the rail and
  uses raw hex — that is the intended behaviour (it forces a re-paint onto tokens), and the rail
  text tells the painter how to comply.
- Fully reversible: re-add the `botanical-leaves` asset entry to restore the static background.
