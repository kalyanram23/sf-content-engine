# menu-cast ↔ content-engine integration — design

**Date:** 2026-07-13 · **Status:** approved by Kal (brainstorm 2026-07-12/13) · **Supersedes:** the
advisory decision log `.claude/handoffs/menucast-integration.md` (I1–I9, re-litigated below)

content-engine fully replaces menu-cast's (ScreenFire's) screen-generation stack. menu-cast keeps
POS sync, AI menu curation, storage, TV pairing, the display route, and the admin UI. The engine
owns everything between "cleaned, filtered menu" and "finished screens on the TV." The replaced
menu-cast code is deleted.

Repos: engine = `/Users/kal/dev/rest/content-engine` (this repo); app = `/Users/kal/dev/rest/menu-cast`
(Next.js 16 monolith on Cloud Run, Firestore + Cloudflare R2); TV client =
`/Users/kal/AndroidStudioProjects/MenuCast` (Fire TV locked-browser WebView, separate repo, **no
changes required** by this design).

---

## 0. Measured facts this design rests on (2026-07-12 telemetry)

All roles on `anthropic/claude-sonnet-5`, real runs, Braintrust project `content-engine`:

| Fact | Number |
| --- | --- |
| Composed screen, passes first QA look | ~$0.07–0.09 · ~1.5–2 min |
| — of which vision critic (dominant cost) | ~$0.06 · 50–80 s per look |
| Composed screen, 3–5 QA iterations | $0.20–0.43 |
| Free-painted screen (non-vocabulary themes) | ~$0.40–0.80 · 5–8+ min |
| Plan (once per restaurant run) | ~$0.03 · ~25 s |
| Full 10-screen restaurant bake (composed) | ~$1 · ~3–5 min (screens parallel) |
| Raw painter HTML | 26–32 KB |
| Packaged self-contained HTML, photo board | 4.9–10.1 MB (~99% base64 photo data-URIs) |
| Packaged self-contained HTML, text board | ~90 KB (inlined fonts dominate) |
| Poster PNG | ~0.5 MB |

Consequences: regeneration is cheap enough that caching exists for **visual stability and instant
daypart swaps**, not cost; generation latency (~2 min) still forbids serve-time generation and
forbids blocking sold-out on a re-bake; photo-board artifact size forbids Firestore storage
(1 MiB doc cap) and — per the Fire TV findings in §8 — forbids serving the self-contained file
to TVs directly.

---

## 1. The seam

- **Input:** menu-cast's curated snapshot — the `menu/live` Firestore doc (`LiveMenuData` /
  `StoredCategory` / `DisplayMenuItem`, see `lib/menu/snapshot-types.ts`, `lib/types.ts`). A thin
  mapper converts it to the engine's `GenerateInput`:
  - items: Toast GUID → `CanonicalItem.id`; curated display category → `category`; consolidated
    size/flavor groups → `sizes`/`variants`; R2 photo URLs → `images` (engine inlines them);
    badges/dietary → `tags`; AI descriptions → `description`.
  - `brand`: restaurant logo (R2 URL) + name from `RestaurantConfig`.
  - `brief`: `presetId` (launch: `dhaba`), optional accent via `palette` overrides, `restaurant`
    slug for observability correlation.
  - `constraints`: `screens` = restaurant's screen count (exact mode), `aspect` from orientation.
- **Output:** the engine's `GenerateOutput` — per screen a fully self-contained HTML document +
  `itemIds` + meta, a poster PNG, and a QA report (`passed`/`flagged`/findings per board).
- **v1 constraint:** one orientation per restaurant per run. Mixed landscape+portrait walls are out
  of scope (the engine plans one aspect per run); revisit as a later engine feature.

## 2. Bake identity — the content-keyed cache

menu-cast computes two keys from the curated snapshot. Bakes are **immutable, content-addressed
artifacts**; identical content is reused byte-for-byte (free, instant, pixel-identical day to day).

- **Plan key** (restaurant-level): ordered set of categories in play for the daypart composition,
  per-category item counts bucketed (so one item added does not rotate it), screen count,
  orientation, theme id + design version (theme file version + a hash of brand/accent overrides),
  engine version. Change ⇒ the category→screen split
  is stale ⇒ **full re-plan**.
- **Screen key** (per screen): plan key + the exact display content of that screen's categories —
  item membership (GUIDs), descriptions, photo set, size/variant structure — hashed over the
  display-relevant projection. Change ⇒ **single-screen re-bake with the pinned plan**.
- **Deliberately excluded from both keys:** stock/86 state, prices, item names. These are
  serve-time overlay concerns (§4) and must never trigger generation. Transient stock never
  redraws a board; scheduled visibility (dayparts) does feed the keys via composition.

**Storage:** R2 `bakes/{restaurantId}/{screenKey}.html` (self-contained archive),
`{screenKey}.lean.html` (serving variant, §4), `{screenKey}.poster.png`. Firestore per restaurant:
a bake index holding the pinned plan (`ThinPlan` JSON + plan key), and per screen: `desiredKey`,
`currentKey`, a small `byComposition` map (daypart-composition id → bake key, maintained at
enqueue/bake time so boundary flips are index lookups, not recomputation), QA status
(`passed`/`flagged` + findings summary), timestamps. Old R2 objects are
garbage-collected after a retention window (default 30 days). Firestore never stores HTML.

## 3. The change ladder

1. **Serve-time overlay — instant, $0, never regenerates:** 86'd items struck out (whole
   categories too — a fully dead category is struck in place, never re-baked); recoveries
   un-struck; price changes patched; **renames patched** (with a deterministic overflow guard:
   step the font down, then ellipsis-chop); removed items hidden.
2. **Single-screen re-bake — ~$0.10, ~2 min:** item added (a new row cannot be overlaid into
   existing HTML); description or photo edited; small composition changes. Plan pinned via the
   engine's static-plan input, so sibling boards do not move.
3. **Full re-plan — ~$1, ~3–5 min:** new/removed category, item churn past a drift threshold
   (default 25%, mirroring today's shipped drift check), screen count or orientation change,
   theme/design/engine version change. **Automatic, threshold + cooldown** (default 30 min) —
   Kal's explicit choice; no approval gate.
4. **Stale-stock purge:** track `firstOutOfStockAt` per item; a recurring overnight job removes
   items out of stock > 2 days and routes the removal through tier 3. Items returning to stock
   later re-enter as additions (tier 2).

Descriptions stay in the key (tier 2) by design: they are multi-line body text that sets card
height; chop/shrink would mutilate the board, and renames usually regenerate the AI description
anyway.

## 4. Serving to TVs

`/d/[token]` (`app/d/[token]/route.ts`) stops rendering and becomes **fetch + overlay**:

1. Read the bake index; compute the current daypart-composition id (cheap: which categories are
   in play right now, from the stored schedule) and pick that entry from the screen's
   `byComposition` map — self-healing, no boundary scheduler; fall back to `currentKey` if the
   composition has no bake yet.
2. Fetch the **lean serving variant** from R2.
3. Append one injected block (string append before `</body>` — no server-side DOM parsing of
   multi-MB documents):
   - **overlay data + script**: dead item GUIDs, current prices, renamed labels; applies
     `.sold-out` strikes (styled via the theme's `--color-sold` token with a generic fallback),
     patches price/name text via the engine's tagged spans, hides removed GUIDs, and applies the
     rename overflow guard;
   - **heartbeat**: `window.ScreenfireBridge.heartbeat()` every ~5 s (hard cross-repo contract
     with the Fire TV app — pinned by an app-side test; missing it force-restarts the app);
   - **scale-to-panel**: today's proven snippet scaling the fixed 1920×1080 (or 1080×1920) stage
     to the panel (one-afternoon on-device QA at 720p/1080p/4K during rollout);
   - **boundary self-flip**: a timer that reloads the page at the next daypart boundary, so swaps
     are sharp even between sync ticks (sync's ping remains the backup).
4. Serve with today's headers (`private, max-age=30, stale-while-revalidate=300`), the 200-always
   contract, and the branded "Reconnecting" fallback. Pairing, HMAC tokens, and the Firestore
   `lastUpdated` ping → TV re-fetch flow are unchanged.

**Lean serving variant:** produced once per bake by the worker — inlined photo data-URIs are
lifted out to R2 objects and replaced with HTTPS URLs; fonts stay inline. ~100 KB page; images are
separately cacheable by the WebView, so the app's full-reload (and its double-fetch render cache)
moves ~200 KB per update instead of ~20 MB, and renderer OOM pressure returns to today's levels.
The self-contained original is archived as the source of truth. The engine is untouched — this is
a worker-side post-process.

**The wall never lies:** prices, availability, strikes, and renames are correct on every TV
refresh regardless of bake age; the only staleness window is a just-added item (absent for the
~2 min of its screen's re-bake).

## 5. Generation infrastructure

- **Bake worker:** a new, small Cloud Run **service** (Node 20+, Chromium via
  `npx playwright install chromium`, `tailwindcss`/`@tailwindcss/node`, `openai`,
  `content-engine/node` as a git-tag dependency — `file:../content-engine` for local dev),
  `OPENROUTER_API_KEY` from Secret Manager. Concurrency 1 per instance; small `maxInstances`
  (LLM budget binds long before infra). Reuses the engine's Braintrust/usage telemetry wiring.
- **Dispatch: named Cloud Tasks** (confirms old I8/I9). Task names give dedup, retry with
  backoff, and rate control:
  - full bake: `bake-{restaurantId}-{planKey}` — worker runs plan + all screens (3–5 min, well
    inside limits);
  - single-screen: `bake-{restaurantId}-{screenKey}` — worker slices the pinned plan to that
    screen, passes only that screen's items, `screens: 1`.
- **Idempotence & races:** artifact exists in R2 ⇒ no-op. The index flip is guarded: the worker
  sets `currentKey = key` in a Firestore transaction **only if** `desiredKey == key` still holds
  (menu-cast writes `desiredKey` at enqueue time); a superseded bake writes its immutable
  artifacts and leaves the index alone. Then it touches `lastUpdated` to ping TVs.
- **Failure containment:** the engine's per-board bulkhead means one bad screen cannot sink a
  run; Cloud Tasks retries transient failures; a screen that exhausts retries keeps its previous
  `currentKey` (previous bake keeps serving).
- **Enqueue sources (all in menu-cast):** the 5-min sync (key diff after each pass), the daypart
  pre-warm (compute keys for the composition at `now + lookahead` (~15 min); enqueue missing),
  curation/design/config changes, the purge job, and the manual regenerate button (bypasses
  cooldown; forces a fresh `desiredKey`).

## 6. Product decisions (Kal, 2026-07-12/13)

| Decision | Choice |
| --- | --- |
| Bake reuse | Content-keyed cache (two-level keys, §2) |
| Re-plan gate | Automatic, threshold + cooldown |
| Sold-out | Overlay only; whole-category strike; never regenerates; 2-day purge job |
| Prices / renames | Overlay-patched, out of the keys (rename overflow guard: shrink → chop) |
| Infra | Separate Cloud Run worker + named Cloud Tasks |
| Visual identity | Engine themes + brand pass-through; menu-cast's palette/font catalog and AI design-picker deleted; owner UI = theme (launch: fixed `dhaba`) + logo + accent |
| Allocation | Engine planner only (reliability pick: deterministic coverage, exact screens, re-plan escape hatch); admin controls screen count + orientation; pins possible later via the engine's static-plan input, no redesign |
| QA-fail policy | **Always ship the best attempt**, flagged or not (matches today's no-gate behavior); findings surfaced in the dashboard |
| Theme scope | Launch `dhaba`-only (the one composed vocabulary); building vocabularies for more themes is a separate engine track that later unlocks a theme picker |

## 7. menu-cast: deleted vs kept

**Deleted (~6,000+ lines):** `lib/menu/layout/` (LLM layout author, resolver, fit/estimate/drift),
`lib/menu/design/` (design author), `lib/menu/compiler/`, `lib/menu/measure/`, `lib/menu/packer/`,
all of `lib/rendering/` (renderer, components, tokens catalog, theme context), the
distribute/layout/design/compiler workflow steps, and the render half of `app/d/[token]/route.ts`.
The Vite template POC (`.scratch/templates-demo/`) is obsolete.

**Kept / reworked:** POS sync (`lib/workflows/sync.ts` — gains key-diffing, enqueueing,
`firstOutOfStockAt` tracking, daypart pre-warm), all of `lib/curation/`, the live snapshot
generator (`lib/menu/live-generator.ts` — it produces the seam input), daypart/time logic
(`time-filter.ts` reworked to feed key computation), a lean live-filter supplying overlay data,
`/d` route (rewritten as §4), slideshow/promo mode (stays menu-cast-owned; gets a new lean home
since `lib/rendering/` dies), pairing/tokens/auth/admin UI, `toast-etl` badges.

**Drift-check note:** today's ≥25% drift re-author becomes the tier-3 threshold on plan-key
inputs — same product behavior, new engine underneath.

## 8. Fire TV app — expectations (separate repo; nothing blocks integration)

- **Required app changes: none.** The app is a locked WebView with exactly one content contract —
  the `ScreenfireBridge.heartbeat()` call (§4 keeps it) — plus 200-always and page-owned scaling,
  all preserved by the serve route.
- **Why the lean variant is load-bearing:** the app fully re-downloads the page on every Firestore
  ping *and* its offline render-cache re-fetches the same URL again on success; raw 5–10 MB bakes
  would move ~20 MB per tick, and renderer OOM on low-RAM sticks trips a **documented, unfixed
  blank-screen bug** (dead WebView reused; watchdog restart after ~45 s is the only recovery).
- **Rollout checklist items:** verify Amazon WebView Chromium version on the oldest supported
  stick — engine CSS needs Chromium ≥ 99 for `@layer` (load-bearing) and ≥ 111 for `color-mix()`
  (4 uses, cosmetic degradation); on-device scale check at 720p/1080p/4K (the app overrides
  display density, clamped at 4K; its viewport fix currently sits uncommitted in the app repo).
- **Recommended app-side fixes (independent track):** commit the viewport fix; fix the
  dead-WebView blank-screen bug; add a reload debounce; reconsider the render-cache double fetch.

## 9. Engine work items (small; sized during planning)

1. **Per-size price binding:** verify/extend the patcher contract so size-matrix price cells are
   individually tagged (e.g. `data-bind="price"` + size discriminator), in both paint paths.
2. **Name binding:** add a tagged name element to the markup contract (free-paint prompt +
   composed vocabulary + QA binding enforcement) so the rename overlay has a reliable target.
3. **Composed patch-contract audit:** confirm the dhaba vocabulary emits `data-item-id` /
   `data-available` / price spans on every item row (QA should already enforce; verify).
4. **`--color-sold` styling:** ensure the theme exposes the sold token so overlay strikes inherit
   theme styling (generic CSS fallback ships in the overlay regardless).
5. **Single-screen invocation check:** confirm `generate()` with a one-screen plan slice + that
   screen's item subset passes the coverage assert (expected to work; verify + test).

Not engine work: key computation, plan slicing, overlay, lean-variant post-process, dispatch —
all live in menu-cast/worker code against the engine's existing public API.

## 10. Rollout

1. Engine work items (§9) land first (behind the engine's normal verify gate).
2. Worker + Cloud Tasks + R2/Firestore index ship to **dev** (`screenfire-dev`); bake real dev
   restaurants; compare side-by-side with the old renderer.
3. Per-restaurant feature flag flips `/d` between old render path and fetch+overlay.
4. Fire TV on-device checks (§8) on dev.
5. Flip prod restaurants; monitor a full daypart cycle + a purge-job cycle.
6. Delete the old stack (§7) once all prod restaurants are flipped; no data migration (bakes
   build themselves on first flag-flip).

**Rollback:** the flag flips back to the old path until deletion day; deletion is the point of no
return and happens last.

## 11. Cost envelope (steady state, per restaurant)

First bake ~$1. Daily operation is dominated by cache hits ($0) + occasional tier-2 re-bakes
(~$0.10 each) + tier-3 re-plans on real menu change or the 2-day purge (~$1 each) ⇒ roughly
**$5–20/month per restaurant** at realistic edit rates, bounded by the purge cadence. Vision-critic
looks dominate spend; future engine-side critic economies directly cut this.

## 12. Relationship to the parked vertical-agnostic re-architecture

That plan (menu-cast `.claude/handoffs/vertical-agnostic-rearch.md`, unstarted) wants ScreenFire
generic across verticals. This integration advances it: the food-specific renderer dies, and the
engine seam is already vertical-neutral (`items + brief`). No renames or registry work are pulled
into this design; the two tracks stay independent.
