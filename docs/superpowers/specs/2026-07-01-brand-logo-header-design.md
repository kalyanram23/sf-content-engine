# Brand logo / header — design

**Date:** 2026-07-01
**Status:** Approved (design), pending implementation plan
**Related decisions:** introduces **D18** (see DECISIONS.md)

## Problem

A venue wants its own brand identity — at minimum a **logo** — to appear as a header on the
generated signage screens. Today the engine has no brand concept: the per-run `brief`
(`themeBrief`) carries `presetId` / `palette` / `density` / `motif` / `notes` / `restaurant`, but
`restaurant` is used only for observability correlation and is never rendered. The "header" you see
today is just the plan's screen/section titles, painted by the LLM from the plan.

The logo source must support **both a URL and a local filesystem path**, so a venue can test
locally with a file on disk before pointing at a hosted asset.

## Goals

- Accept optional brand content per run: a **logo** image plus optional **name** and **tagline** text.
- Logo source may be an `http(s)://` URL, a local filesystem path, or an existing `data:` URI.
- Render the brand as a **header band** (logo + title) on **every** screen, painted by the LLM on
  rails and covered by QA — consistent with the engine's "free paint on rails" philosophy.
- Keep the pure core hermetic (no network/fs) and the shipped artifact offline-safe (logo inlined
  as a `data:` URI, like item photos).
- Fully backward-compatible: `brand` is optional; existing inputs behave exactly as before.

## Non-goals (YAGNI)

- **Brand color** — already covered by `brief.palette` token overrides; not duplicated here.
- Per-screen logo variation, light/dark logo variants, or logo animation.
- Deterministic fixed-height header bands (the LLM lays out the band on rails; QA guards it).
- A general "asset library" input. This is one per-run logo asset.

## Assumptions (confirmed with user)

1. **Scope:** logo image + optional `name` + `tagline` text.
2. **Placement:** header on **every** screen.
3. **Style:** header band (logo + title), painter-authored on rails (not a deterministic band).
4. **Local file support:** accept both a bare path and a `file://` URL.
5. **Unreadable logo → fail loud** (a structured error), unlike item photos which degrade to a
   placeholder — because a logo the user explicitly pointed at that can't be read is a real
   misconfiguration, not a flaky third-party photo host.

## Architecture decision: resolution at the Node composition root (D18)

A logo `src` that is a URL or fs path must become a `data:` URI **before** it reaches the pure core
(which touches neither network nor fs). Options considered:

| Approach | Summary | Verdict |
|---|---|---|
| **A. Resolve at the Node composition root** | `createNodeEngine` wraps `generate`, normalizes `brand.logo.src` → data-URI, delegates to the pure engine. | **Chosen** |
| B. Extend `ImageFetcher` + resolve in-pipeline | Broaden the URL-only port to read fs; add logo to the per-screen `fetchImages` node. | Rejected — changes an established port's contract; brand is per-run, not per-screen. |
| C. New `BrandAssetResolver` port | Dedicated port + node + fake. | Rejected — most machinery for a single per-run asset. |

**Rationale:** a logo is a single per-run asset, so a one-shot normalization at the input boundary
is the natural place. Approach A keeps the pure core (`createEngine`) completely unchanged and
hermetic, and confines fs/network to the adapter layer exactly as the architecture demands.
`createNodeEngine` is already the composition root, so normalizing its input there fits.

## Data model (`src/domain/schemas.ts`, `src/domain/types.ts`)

New optional `brand` on `generateInputSchema`:

```ts
export const brandLogoSchema = z.object({
  /** data: URI | http(s):// URL | local fs path | file:// URL. Resolved to a data-URI by the Node root. */
  src: z.string().min(1),
  /** Accessibility / fallback text for the logo image. */
  alt: z.string().optional(),
});

export const brandInputSchema = z.object({
  logo: brandLogoSchema.optional(),
  name: z.string().min(1).optional(),
  tagline: z.string().min(1).optional(),
});

// generateInputSchema gains:
//   brand: brandInputSchema.optional()
```

`BrandInput` / `BrandLogo` types are derived via `z.infer` in `src/domain/types.ts`, following the
existing pattern. Because `brand` is optional and additive, no existing input breaks. Respect
`exactOptionalPropertyTypes`: build `brand` objects with conditional spreads, never `field:
undefined`.

## Resolution (`src/adapters/node-engine.ts` + helper)

New adapter helper (fs/network live in the adapter layer, allowed by the hermetic boundary):

```ts
// src/adapters/image/asset-resolver.ts (or similar)
export async function resolveAssetToDataUri(src: string): Promise<string>;
```

Behavior by source kind:
- `data:` → return unchanged.
- `http(s)://` → fetch bytes (reuse the same fetch path `NodeImageFetcher` uses), sniff MIME, base64
  → `data:<mime>;base64,…`.
- `file://` or a bare path → read bytes from fs, sniff MIME by extension, base64 → data-URI.

`createNodeEngine` returns a thin wrapper instead of the raw pure engine:

```ts
const engine = createEngine(ports, options.config);
return {
  async generate(input: unknown): Promise<GenerateOutput> {
    return engine.generate(await normalizeBrandLogo(input));
  },
};
```

`normalizeBrandLogo` does a light structural read: if `input.brand.logo.src` is present and not
already a `data:` URI, resolve it and return a shallow-rebuilt input with the resolved src. Full
validation still happens inside the pure engine via `parseOrThrow` (unchanged). The pure core only
ever sees a `data:` URI.

**Error handling — fail loud.** Introduce `BrandAssetError extends ContentEngineError` with a stable
`code` (e.g. `"BRAND_ASSET"`), thrown on fs-not-found / unreadable / fetch failure, with a clear
message (`brand logo could not be read from "<src>"`). This deliberately differs from item photos
(which degrade to `PLACEHOLDER_IMAGE_DATA_URI`).

## Threading through the pure core (no new state channel)

`brand` travels inside `state.input` (already threaded end-to-end), so it is available at the paint
and package nodes as `state.input.brand` — no new `EngineState` channel is needed. It is surfaced to:

- `PaintRequest.brand` — `{ logo?: { /* data-URI src */ , alt? }, name?, tagline? }` (add to
  `src/ports/painter.ts`; populated in `paintNode`).
- `PackageRequest.brand` — the resolved logo data-URI (add to `src/ports/packager.ts`; populated in
  `packageNode`).

## Painter prompt (`src/adapters/openrouter/painter.ts`)

Add a **BRAND** section to the prompt that fires only when `brand` is present. It reuses the existing
photo-placeholder scheme so the large base64 blob never passes through the LLM (an LLM cannot
reliably reproduce a long data-URI):

- Render a **header band** at the top of the screen combining the logo with the screen title.
- Emit the logo as `<img data-brand-logo>` **with NO `src`** (and an `alt` when provided). The engine
  inlines the real data-URI at package time. Never put a URL in `src`.
- Size the logo as a real header element — not a tiny thumbnail, not overpowering the menu — on a
  theme surface that suits it (transparent logos need an appropriate backing).
- Render brand `name` / `tagline` (short strings, passed directly in the user prompt) as text
  beside/under the logo.

This mirrors the existing item-photo instruction (`<img data-img-item data-img-index>` with no src).

## Packager injection (`src/adapters/tailwind/packager.ts`)

New `inlineBrandLogo(root, brand)` mirroring `inlineItemImages`: query `[data-brand-logo]`, set
`src` to the resolved logo data-URI (or `PLACEHOLDER_IMAGE_DATA_URI` when the logo is absent). Runs
alongside `inlineItemImages`, before serialization, so the shipped artifact carries no remote src and
stays offline-safe. `PackageRequest` gains the brand logo data-URI so the packager can look it up.

## QA

- **Contrast / tokens:** the band uses theme tokens, so the existing token-lint and WCAG contrast
  checks already cover the header text. No new contrast logic.
- **New light structural check** (`src/qa/structural-checks.ts`, e.g. `checkBrandBinding`): when
  `brand.logo` is provided, assert at least one `[data-brand-logo]` element exists and that no raw
  URL leaked into its `src` — so the LLM cannot silently omit the logo. This matches the codebase's
  "structural guarantee, not vibes" philosophy (cf. binding-integrity for items). Wire it into
  `runStructuralChecks`; severity governed by the existing `blockingSeverity` config. The
  `StructuralContext` gains whether a brand logo was requested.

## Testing

All hermetic (fakes only; no network/fs/key), staying in the default `vitest run` suite:

- **Schema unit:** `brandInputSchema` accepts logo + name + tagline; rejects empty `src`; `brand`
  omitted still validates.
- **Resolver unit:** `data:` passthrough; fs read → data-URI (temp file in the scratch dir); missing
  path → `BrandAssetError`.
- **Packager unit:** `<img data-brand-logo>` receives the injected data-URI; absent logo → placeholder.
- **Structural-check unit:** logo requested but no placeholder → finding; placeholder with leaked URL
  src → finding; correct placeholder → clean.
- **e2e (fakes):** `FakePainter` emits the brand placeholder; assert packaged HTML carries the inlined
  logo and the brand-binding check passes. Reuse existing scenario-scripted fakes.

## Documentation

- **DECISIONS.md:** add **D18** — brand is a per-run input; logo resolves to a data-URI at the Node
  composition root (Approach A); unreadable logo fails loud (vs. item-photo degrade).
- **ARCHITECTURE.md:** short note on the `brand` input and the resolve-at-root step.
- **CLAUDE.md:** one line documenting the new optional `brand` input field.

## Backward compatibility

`brand` is optional everywhere. Runs without it behave identically. `PaintRequest.brand` /
`PackageRequest.brand` are optional additions; existing fakes and adapters compile unchanged (the new
structural check is a no-op when no brand logo is requested).

## Open questions

None blocking. The user confirmed scope, every-screen placement, header-band style, both path forms,
and fail-loud error handling.
