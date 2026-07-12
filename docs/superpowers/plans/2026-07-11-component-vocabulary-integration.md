# Component-Vocabulary Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fold the validated `prototypes/component-vocab/` architecture into the engine as a first-class paint path: an LLM **composer** emits a tiny structured composition over a **closed, theme-owned component vocabulary**; a deterministic **layout engine + renderer** expand it into the board — behind the existing `Painter` port, with the free-paint painter as automatic fallback for themes without a vocabulary.

**Architecture:** Three cleanly separated layers. (1) **Engine-owned, theme-agnostic**: the composition contract (what blocks *exist*: `section`, `group`, `photoBand`), the `Composer` LLM port, the layout engine (aspect planning, register search, measured column partition, coverage guarantee), and the `CompositionPainter` that orchestrates them behind `Painter`. (2) **Theme-owned, pluggable**: a `ComponentVocabulary` package (code, not JSON) that renders each abstract block in the theme's visual language and declares its size registers/metrics; resolved via a `VocabularyRegistry` port keyed by a new `vocabulary` field in the theme JSON. (3) **Existing engine, minimally touched**: zero graph changes; QA learns exactly one thing (composed HTML is trusted against token-lint); packager/fetchImages/QA/score/freeze run unchanged because the renderer emits engine-legal markup (`data-item-id` bindings, `data-img-item` photo placeholders, single root element).

**Tech Stack:** TypeScript ESM (strict: `verbatimModuleSyntax`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`), Zod 4 (`z.toJSONSchema`, `.prefault({})`), OpenRouter structured outputs, playwright-core (measure pass), vitest (hermetic fakes), LangGraph untouched.

## Global Constraints

- `npm run verify` (prettier → eslint → tsc → vitest) must be green after **every** task; the suite is hermetic — no network, browser, or API key.
- Only `src/node.ts` and `src/adapters/**` may import optional peers (`openai`, `playwright-core`, `tailwindcss`, `@tailwindcss/node`) or `src/adapters/**` modules (eslint-enforced hermetic boundary).
- Zod 4 idioms: `z.toJSONSchema(...)` for LLM contracts, `.prefault({})` (never `.default({})`) for all-defaulted nested config objects.
- Strict LLM contracts live in `src/domain/contracts.ts`, must be strict-JSON-Schema compatible: **no top-level unions**, all fields required (use `""`/`[]` sentinels for unused fields — the `planBlockSchema` precedent).
- `exactOptionalPropertyTypes`: never pass `{ field: undefined }` — spread conditionally: `...(x !== undefined ? { field: x } : {})`.
- `noPropertyAccessFromIndexSignature`: bracket-access index signatures (`heights["__cue__"]`).
- `import type` for type-only imports (eslint enforces).
- LangGraph node ids must not collide with state channel names — this plan adds **no** graph nodes or state channels.
- token-lint runs on RAW painter HTML; deterministic renderer output is exempted via the `data-composed` root marker (Task 8) — free-paint HTML must keep linting exactly as before.
- New DECISIONS.md entries continue from **D71**.
- The prototype source of truth is `prototypes/component-vocab/{catalog,fitter,render,compose}.ts` — port code from there with the deltas each task specifies; do not import from `prototypes/` (it is outside the lint/tsc gate).
- Model allowlist: any new model role must be checked against `structuredOutputAllowlist` at config load (D11).
- Commit after every task (each task ends with a commit step).

## File Structure (locked decomposition)

```
src/domain/contracts.ts            MODIFY  composition contract (strict schema)
src/domain/schemas.ts              MODIFY  theme `vocabulary` field
src/domain/types.ts                MODIFY  re-export new types
src/ports/composer.ts              CREATE  Composer port (LLM)
src/ports/vocabulary-registry.ts   CREATE  ComponentVocabulary + VocabularyRegistry interfaces
src/ports/browser.ts               MODIFY  add measure() to BrowserPort
src/ports/index.ts                 MODIFY  export new ports; EnginePorts gains composer?/vocabularies?
src/composition/layout.ts          CREATE  generic layout engine (planLayout, fit, partitionColumns)
src/composition/renderer.ts        CREATE  generic renderer (normalize, coverage, stack/columns, cues)
src/composition/digest.ts          CREATE  PlanScreen+items → composer digest + photo candidates
src/composition/painter.ts         CREATE  CompositionPainter implements Painter
src/composition/auto-painter.ts    CREATE  AutoPainter (per-request composition|free selection)
src/vocabularies/dhaba/index.ts    CREATE  dhaba ComponentVocabulary (registers, components, shell)
src/vocabularies/index.ts          CREATE  builtinVocabularies() registry
src/adapters/openrouter/composer.ts CREATE OpenRouterComposer adapter
src/adapters/playwright/browser.ts MODIFY  implement measure()
src/adapters/node-engine.ts        MODIFY  wire composer + registry + AutoPainter
src/config/models.ts               MODIFY  add "compose" role
src/config/painter.ts              MODIFY  add paint mode (auto|free|composition)
src/qa/structural-checks.ts        MODIFY  token-lint exemption for data-composed
src/testing/fakes/composer.ts      CREATE  FakeComposer
src/testing/fakes/browser.ts       MODIFY  ScriptedBrowser.measure()
src/testing/fakes/index.ts         MODIFY  export + wire into createFakeEngine
themes/dhaba.theme.json            MODIFY  "vocabulary": "dhaba"
scripts/try.ts                     MODIFY  compose model role config
DECISIONS.md                       MODIFY  D71–D74
ARCHITECTURE.md                    MODIFY  composition path section
```

Dependency order: Task 1 → 2 → 3 → 4 → 5 → 6 (parallel-safe with 7) → 7 → 8 → 9 → 10 → 11 → 12.

---

### Task 1: Composition contract (strict LLM schema)

The engine-owned, theme-agnostic "order form". Three abstract block kinds — themes decide how they *look*, never what *exists*. Strict-mode friendly: flat object, `kind` enum, all fields required with `""`/`[]` sentinels (the `planBlockSchema` precedent, D11).

**Files:**
- Modify: `src/domain/contracts.ts` (append after `planLayoutSchema`)
- Test: `src/domain/contracts.test.ts` (create; the repo has no contracts test yet — colocate per repo convention)

**Interfaces:**
- Produces: `compositionBlockSchema`, `compositionResponseSchema`, types `CompositionBlock`, `CompositionResponse`. Consumed by Tasks 3, 5, 6, 7.

- [ ] **Step 1: Write the failing test**

```ts
// src/domain/contracts.test.ts
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { compositionResponseSchema } from "./contracts";

describe("compositionResponseSchema", () => {
  it("accepts a minimal composition and applies sentinels", () => {
    const parsed = compositionResponseSchema.parse({
      title: "Street & Sweets",
      blocks: [
        { kind: "section", section: "Dosa", sections: [], itemIds: [] },
        { kind: "photoBand", section: "", sections: [], itemIds: ["t1", "w1", "x1"] },
        { kind: "group", section: "", sections: ["Chaat", "Hot Drinks"], itemIds: [] },
      ],
    });
    expect(parsed.blocks).toHaveLength(3);
    expect(parsed.blocks[1]?.itemIds).toEqual(["t1", "w1", "x1"]);
  });

  it("converts to a strict-compatible JSON Schema (object root, no top-level union)", () => {
    const js = z.toJSONSchema(compositionResponseSchema) as {
      type?: string;
      properties?: Record<string, unknown>;
    };
    expect(js.type).toBe("object");
    expect(Object.keys(js.properties ?? {})).toEqual(["title", "blocks"]);
  });

  it("rejects an unknown kind", () => {
    expect(() =>
      compositionResponseSchema.parse({
        title: "X",
        blocks: [{ kind: "hero", section: "", sections: [], itemIds: [] }],
      }),
    ).toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/domain/contracts.test.ts`
Expected: FAIL — `compositionResponseSchema` is not exported.

- [ ] **Step 3: Implement the schema**

Append to `src/domain/contracts.ts`:

```ts
/**
 * The composition contract (D71) — the ENGINE-OWNED abstract "order form" a composer LLM fills
 * against a closed component vocabulary. Deliberately theme-agnostic: the three block kinds are
 * the only structures ANY vocabulary must render; a theme decides how a block LOOKS, never what
 * blocks EXIST. Strict-mode shape (D11): flat object, `kind` enum, every field required — unused
 * fields carry ""/[] sentinels (the planBlockSchema precedent). The LLM decides JUDGMENT only
 * (order, grouping, photo picks, title); all arithmetic (sizes, columns, type scale) is the
 * deterministic layout engine's.
 */
export const compositionBlockSchema = z.object({
  /** Which abstract component this block renders. */
  kind: z.enum(["section", "group", "photoBand"]),
  /** kind "section": the exact section title to render full-width; "" otherwise. */
  section: z.string(),
  /** kind "group": 2–3 exact section titles side by side in one band; [] otherwise. */
  sections: z.array(z.string()),
  /** kind "photoBand": 3–12 item ids from the photo library; [] otherwise. */
  itemIds: z.array(z.string()),
});
export type CompositionBlock = z.infer<typeof compositionBlockSchema>;

/** What the composer LLM returns — board title + ordered body blocks (top to bottom). */
export const compositionResponseSchema = z.object({
  /** Short human masthead title (e.g. "Street & Sweets"). The one sanctioned invented-copy field. */
  title: z.string().min(1),
  blocks: z.array(compositionBlockSchema),
});
export type CompositionResponse = z.infer<typeof compositionResponseSchema>;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/domain/contracts.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Full gate + commit**

Run: `npm run verify` — green.

```bash
git add src/domain/contracts.ts src/domain/contracts.test.ts
git commit -m "feat(domain): composition contract — engine-owned strict schema for the component-vocabulary order form (D71)"
```

---

### Task 2: Vocabulary + registry + composer ports

The pluggability seam. `ComponentVocabulary` is the interface every theme package implements; `VocabularyRegistry` resolves one by id; `Composer` is the LLM port. All pure interfaces — no implementation yet.

**Files:**
- Create: `src/ports/vocabulary-registry.ts`
- Create: `src/ports/composer.ts`
- Modify: `src/ports/index.ts`
- Test: `src/ports/vocabulary-registry.test.ts` (type-level smoke: a literal object satisfies the interface)

**Interfaces:**
- Consumes: `CompositionResponse` (Task 1), `RequestCorrelation` (existing).
- Produces (exact signatures — later tasks depend on these):

```ts
// src/ports/vocabulary-registry.ts  — full file
import type { BrandInput } from "../domain/types";

/** A resolved menu section handed to a vocabulary: title + display-ready items. */
export interface VocabSection {
  title: string;
  items: VocabItem[];
}
export interface VocabItem {
  id: string;
  name: string;
  /** null = market price (vocabulary renders its MP treatment). */
  price: number | null;
  /** True when the item has a photo (renderer emits a data-img-item placeholder for it). */
  hasImage: boolean;
}

export interface VocabCanvas {
  width: number;
  height: number;
}

/** How a photoBand presents its photos. The theme picks its default; config may override. */
export type PhotoBandMode = "static" | "crossfade" | "filmstrip";

/**
 * Size/space metrics for ONE register — everything the generic layout engine needs to fit
 * content without knowing any theme CSS. All heights in px at the given register.
 */
export interface VocabularyMetrics {
  /** Estimated height of a full-width section at `internalCols` internal price columns. */
  sectionHeight(itemCount: number, internalCols: number): number;
  /** Estimated height of a side-by-side group band (driven by its tallest member). */
  groupHeight(itemCounts: number[]): number;
  /** Height of a photo band at this register (stack mode). */
  photoBandHeight(): number;
  /** Landscape flow: estimated height of one continuation row / one lead (header+first row). */
  flowRowHeight(): number;
  flowLeadHeight(): number;
  /** Height of the continuation cue line stamped at a spilled column top. */
  cueHeight(): number;
  /** Internal price columns a section of `itemCount` uses when up to `max` are allowed. */
  sectionInternalCols(itemCount: number, max: number): number;
}

/** Arguments for shell rendering (frame + masthead around the body). */
export interface ShellArgs {
  title: string;
  tagline: string | null;
  canvas: VocabCanvas;
  register: string;
  bodyHtml: string;
  brand?: BrandInput;
}

/**
 * A pluggable theme component package (D71): hand-designed components, mined per theme, that
 * render the engine's three abstract block kinds in the theme's visual language. Implementations
 * are PURE (no IO, no clock, no randomness) and must emit ENGINE-LEGAL markup:
 *   - one single root element per render call (the packager wraps the document);
 *   - theme tokens as var(--color-<token>) only — the shell declares them from the theme;
 *   - every item row stamped data-item-id="<id>" (binding-integrity QA);
 *   - every photo as `<img data-img-item="<id>" data-img-index="0">` with NO src
 *     (the packager inlines the offline data-URI — spec §5.1);
 *   - no external <link>/<script>; fonts come from theme assets via the packager.
 */
export interface ComponentVocabulary {
  id: string;
  /** Bumped when rendered output changes materially (pixel-test snapshots key on it). */
  version: number;
  /** Register names, LARGEST first (the layout engine searches in this order). */
  registerNames: readonly string[];
  /** Theme default presentation for photoBand blocks. */
  defaultPhotoMode: PhotoBandMode;
  /** The theme's content box inside its shell chrome (frame, masthead, padding). */
  contentBox(canvas: VocabCanvas): { width: number; height: number };
  /** Landscape flow tuning owned by the theme's type: narrowest legible column, rhythm, banner. */
  minStreamWidth: number;
  sectionGap: number;
  landscapeBannerHeight: number;
  metrics(register: string): VocabularyMetrics;
  renderShell(args: ShellArgs): string;
  renderSection(args: {
    number: number;
    section: VocabSection;
    internalCols: number;
    register: string;
  }): string;
  renderGroup(args: { startNumber: number; sections: VocabSection[]; register: string }): string;
  renderPhotoBand(args: {
    items: VocabItem[];
    register: string;
    bandHeight: number;
    bandWidth: number;
    mode: PhotoBandMode;
    uid: string;
  }): string;
  /** Landscape flow pieces: lead = numbered header GLUED to the first row (never orphaned). */
  renderFlowLead(args: { number: number; section: VocabSection; register: string }): string;
  renderFlowRow(args: { item: VocabItem; register: string }): string;
  renderContinuationCue(args: { sectionTitle: string; register: string }): string;
  /**
   * One line per block kind describing this theme's rendering, injected into the composer
   * prompt (e.g. `photoBand: "a filmstrip of tilted polaroid photo cards"`), so the LLM
   * composes with the theme's voice in mind without ever seeing HTML.
   */
  promptNotes: Readonly<Record<"section" | "group" | "photoBand", string>>;
}

/** Resolves a vocabulary id (the theme's `vocabulary` field) to its package. Pure + sync. */
export interface VocabularyRegistry {
  get(id: string): ComponentVocabulary | undefined;
}
```

```ts
// src/ports/composer.ts — full file
import type { CompositionResponse } from "../domain/contracts";
import type { RequestCorrelation } from "./correlation";

export interface ComposeRequest {
  /** Compact board-content digest: sections, item names+prices, photo-eligible ids. */
  digest: string;
  /** Vocabulary-aware prompt block (block kinds + the theme's promptNotes). */
  vocabularyPrompt: string;
  canvas: { width: number; height: number };
  /** On a re-compose after QA findings: the findings to address, human-readable. */
  findingsNote?: string;
  correlation?: RequestCorrelation;
}

/**
 * The composition LLM (D71): fills the strict order form (compositionResponseSchema) — judgment
 * only (block order, grouping, photo picks, board title). Structured outputs enforce the shape;
 * the renderer enforces coverage + photo-truth regardless of what comes back.
 */
export interface Composer {
  compose(request: ComposeRequest): Promise<CompositionResponse>;
}
```

- [ ] **Step 1: Write the failing test**

```ts
// src/ports/vocabulary-registry.test.ts
import { describe, expect, it } from "vitest";

import type { ComponentVocabulary, VocabularyRegistry } from "./vocabulary-registry";

describe("VocabularyRegistry contract", () => {
  it("a map-backed registry satisfies the interface", () => {
    const vocab = {
      id: "noop",
      version: 1,
      registerNames: ["M"],
      defaultPhotoMode: "static",
      contentBox: (c) => ({ width: c.width, height: c.height }),
      minStreamWidth: 400,
      sectionGap: 12,
      landscapeBannerHeight: 200,
      metrics: () => ({
        sectionHeight: (n) => n * 20,
        groupHeight: (ns) => Math.max(...ns) * 20,
        photoBandHeight: () => 200,
        flowRowHeight: () => 20,
        flowLeadHeight: () => 50,
        cueHeight: () => 24,
        sectionInternalCols: (n, max) => (n <= 4 ? 1 : max),
      }),
      renderShell: ({ bodyHtml }) => `<div data-composed="noop@1">${bodyHtml}</div>`,
      renderSection: ({ section }) => `<div>${section.title}</div>`,
      renderGroup: ({ sections }) => `<div>${sections.length}</div>`,
      renderPhotoBand: () => `<div></div>`,
      renderFlowLead: ({ section }) => `<div>${section.title}</div>`,
      renderFlowRow: ({ item }) => `<div data-item-id="${item.id}"></div>`,
      renderContinuationCue: ({ sectionTitle }) => `<div>${sectionTitle} (cont.)</div>`,
      promptNotes: { section: "s", group: "g", photoBand: "p" },
    } satisfies ComponentVocabulary;
    const registry: VocabularyRegistry = new Map([[vocab.id, vocab]]);
    expect(registry.get("noop")?.id).toBe("noop");
    expect(registry.get("missing")).toBeUndefined();
  });
});
```

(Note: `Map<string, ComponentVocabulary>` structurally satisfies `VocabularyRegistry` — its `get` returns `ComponentVocabulary | undefined`. This is intentional; the node root uses a plain Map.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/ports/vocabulary-registry.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Create both port files** with the exact contents shown in **Interfaces** above.

- [ ] **Step 4: Export from `src/ports/index.ts`**

Add to the type re-exports:

```ts
export type { Composer, ComposeRequest } from "./composer";
export type {
  ComponentVocabulary,
  VocabularyRegistry,
  VocabularyMetrics,
  VocabSection,
  VocabItem,
  VocabCanvas,
  PhotoBandMode,
  ShellArgs,
} from "./vocabulary-registry";
```

And extend `EnginePorts` (both optional — themes without vocabularies never touch them):

```ts
  /** The composition LLM for vocabulary themes (D71). Optional: free-paint-only deployments omit it. */
  composer?: Composer;
  /** Pluggable theme component packages, keyed by the theme JSON's `vocabulary` field (D71). */
  vocabularies?: VocabularyRegistry;
```

(with `import type { Composer } from "./composer";` and `import type { VocabularyRegistry } from "./vocabulary-registry";` at the top).

- [ ] **Step 5: Run test + gate, commit**

Run: `npx vitest run src/ports/vocabulary-registry.test.ts` → PASS. `npm run verify` → green.

```bash
git add src/ports/composer.ts src/ports/vocabulary-registry.ts src/ports/vocabulary-registry.test.ts src/ports/index.ts
git commit -m "feat(ports): Composer + ComponentVocabulary/VocabularyRegistry ports — the pluggable theme-package seam (D71)"
```

---

### Task 3: Generic layout engine (`src/composition/layout.ts`)

Port the prototype's `fitter.ts` with the theme numbers **removed** — everything theme-specific now arrives through `VocabularyMetrics`/`ComponentVocabulary`. The partition DP moves over verbatim (it is already generic).

**Files:**
- Create: `src/composition/layout.ts`
- Test: `src/composition/layout.test.ts`
- Reference: `prototypes/component-vocab/fitter.ts` (port source)

**Interfaces:**
- Consumes: `ComponentVocabulary`, `VocabularyMetrics`, `VocabCanvas` (Task 2), `CompositionBlock` (Task 1).
- Produces (exact — Tasks 5 and 4 tests rely on these):

```ts
export type LayoutMode = "stack" | "columns";
export interface LayoutPlan {
  mode: LayoutMode;
  bodyWidth: number;
  bodyHeight: number;
  gap: number;
  minColumns: number;
  maxColumns: number;
}
export interface ResolvedLayout {
  mode: LayoutMode;
  columns: number;
  columnWidth: number;
  maxInternalCols: number;
  gap: number;
  bodyWidth: number;
  bodyHeight: number;
}
export interface FitResult {
  register: string;
  layout: ResolvedLayout;
  contentHeight: number;
  usedHeight: number;
  fill: number;
  bannerHeight: number;
}
export interface FlowUnitSize { height: number; isLead: boolean }

export function planLayout(canvas: VocabCanvas, vocab: ComponentVocabulary): LayoutPlan;
export function fit(input: {
  blocks: CompositionBlock[];
  sectionsByTitle: Map<string, VocabSection>;
  plan: LayoutPlan;
  vocab: ComponentVocabulary;
  banner?: CompositionBlock | null;
}): FitResult;
export function partitionColumns(units: FlowUnitSize[], columns: number, cueH: number): number[][];
```

**Port deltas from `prototypes/component-vocab/fitter.ts` (exhaustive):**
1. Delete the `REGISTERS` table, `Register` interface, `rowH`/`headerH`, `contentBox`, `collageBandHeight`, `sectionColumns`, and all px constants (`FRAME`, `HEADER`, `PAD_*`, `MIN_STREAM_WIDTH`, `SECTION_GAP`, `LANDSCAPE_BANNER_H`) — those numbers are dhaba's and move into Task 4's vocabulary.
2. `planLayout(canvas)` → `planLayout(canvas, vocab)`: body box = `vocab.contentBox(canvas)`; `MIN_STREAM_WIDTH` → `vocab.minStreamWidth`; `COL_GAP` stays engine-generic at `44`.
3. `blockHeight(...)` rewrites against `VocabularyMetrics`: `photoBand` → `m.photoBandHeight()`; `group` → `m.groupHeight(itemCounts)`; `section` → `m.sectionHeight(count, m.sectionInternalCols(count, maxInternalCols))`. Block field names change from the prototype's (`collage`/`triBand`, `block.section`) to the contract's (`photoBand`/`group`, same `section` field, `sections`, `itemIds`).
4. Register search: iterate `vocab.registerNames` (largest-first) instead of the hardcoded `["L","M","S"]`; register rank = reverse index in `registerNames`.
5. `SECTION_GAP` in `fit`'s columns math and in `partitionColumns` callers → `vocab.sectionGap`; `partitionColumns` itself keeps a `sectionGap` **parameter-free** port EXCEPT: change the `step`/`colCost` uses of the module constant to a new third parameter — final signature `partitionColumns(units, columns, cueH)` stays as in the prototype but the `SECTION_GAP` constant becomes a module-level default of `14` **only** inside the DP via an optional 4th param `sectionGap = 14`; `fit` and the renderer pass `vocab.sectionGap` explicitly.
6. Banner height in columns fit: `vocab.landscapeBannerHeight + BANNER_GAP` (keep `BANNER_GAP = 24` engine-generic, exported).
7. Stack fill target `0.92` and columns fill target `0.95` stay engine-generic module constants (`STACK_FILL`, `COLUMNS_FILL`), exported for tests.

- [ ] **Step 1: Write the failing tests**

```ts
// src/composition/layout.test.ts
import { describe, expect, it } from "vitest";

import type { ComponentVocabulary } from "../ports/vocabulary-registry";
import { fit, partitionColumns, planLayout } from "./layout";

/** Minimal deterministic vocabulary: every row 20px, headers 40px, two registers. */
const testVocab = {
  id: "test",
  version: 1,
  registerNames: ["L", "S"],
  defaultPhotoMode: "static",
  contentBox: (c) => ({ width: c.width - 100, height: c.height - 200 }),
  minStreamWidth: 300,
  sectionGap: 10,
  landscapeBannerHeight: 150,
  metrics: (register: string) => {
    const row = register === "L" ? 30 : 20;
    return {
      sectionHeight: (n: number, cols: number) => 40 + Math.ceil(n / cols) * row,
      groupHeight: (ns: number[]) => 30 + Math.max(...ns) * row,
      photoBandHeight: () => 200,
      flowRowHeight: () => row,
      flowLeadHeight: () => 40 + row,
      cueHeight: () => 24,
      sectionInternalCols: (n: number, max: number) => (n <= 4 ? 1 : max),
    };
  },
  renderShell: ({ bodyHtml }) => `<div>${bodyHtml}</div>`,
  renderSection: () => "<div></div>",
  renderGroup: () => "<div></div>",
  renderPhotoBand: () => "<div></div>",
  renderFlowLead: () => "<div></div>",
  renderFlowRow: () => "<div></div>",
  renderContinuationCue: () => "<div></div>",
  promptNotes: { section: "", group: "", photoBand: "" },
} satisfies ComponentVocabulary;

const sections = new Map(
  [
    { title: "A", items: Array.from({ length: 10 }, (_, i) => ({ id: `a${i}`, name: `A${i}`, price: 1, hasImage: false })) },
    { title: "B", items: Array.from({ length: 6 }, (_, i) => ({ id: `b${i}`, name: `B${i}`, price: 1, hasImage: false })) },
  ].map((s) => [s.title, s]),
);

describe("planLayout", () => {
  it("portrait → stack; landscape → columns with a searchable column range", () => {
    expect(planLayout({ width: 1080, height: 1920 }, testVocab).mode).toBe("stack");
    const l = planLayout({ width: 1920, height: 1080 }, testVocab);
    expect(l.mode).toBe("columns");
    expect(l.minColumns).toBe(2);
    expect(l.maxColumns).toBeGreaterThanOrEqual(2);
  });
});

describe("fit", () => {
  it("stack: picks the LARGEST register that fits within the fill target", () => {
    const plan = planLayout({ width: 1080, height: 1920 }, testVocab);
    const res = fit({
      blocks: [
        { kind: "section", section: "A", sections: [], itemIds: [] },
        { kind: "section", section: "B", sections: [], itemIds: [] },
      ],
      sectionsByTitle: sections,
      plan,
      vocab: testVocab,
    });
    expect(res.register).toBe("L"); // 2 sections easily fit at L in 1720px of body
    expect(res.layout.mode).toBe("stack");
  });

  it("falls to the smaller register when the large one overflows", () => {
    const tall = new Map(
      [{ title: "BIG", items: Array.from({ length: 200 }, (_, i) => ({ id: `x${i}`, name: `X${i}`, price: 1, hasImage: false })) }].map(
        (s) => [s.title, s],
      ),
    );
    const plan = planLayout({ width: 1080, height: 1920 }, testVocab);
    const res = fit({
      blocks: [{ kind: "section", section: "BIG", sections: [], itemIds: [] }],
      sectionsByTitle: tall,
      plan,
      vocab: testVocab,
    });
    expect(res.register).toBe("S"); // 100 rows/col at L = 3040px > 0.92*1720
  });
});

describe("partitionColumns", () => {
  it("balances measured units into contiguous groups and never splits a lead from index 0", () => {
    const units = [
      { height: 50, isLead: true },
      ...Array.from({ length: 9 }, () => ({ height: 20, isLead: false })),
      { height: 50, isLead: true },
      ...Array.from({ length: 5 }, () => ({ height: 20, isLead: false })),
    ];
    const groups = partitionColumns(units, 2, 24);
    expect(groups).toHaveLength(2);
    // contiguous + total coverage
    expect(groups.flat()).toEqual(Array.from({ length: units.length }, (_, i) => i));
    // balance: tallest column within one row of the ideal half
    const heightOf = (g: number[]) => g.reduce((s, i) => s + units[i]!.height, 0);
    expect(Math.abs(heightOf(groups[0]!) - heightOf(groups[1]!))).toBeLessThanOrEqual(50);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/composition/layout.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Port `fitter.ts` → `src/composition/layout.ts`** applying the seven deltas listed above. Keep the DP (`partitionColumns`) logic byte-equivalent apart from the `sectionGap` parameterization; keep the joint (columns, register) search structure and the `best ?? densest` honesty fallback with its explanatory comments.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/composition/layout.test.ts` → PASS.

- [ ] **Step 5: Gate + commit**

`npm run verify` → green.

```bash
git add src/composition/layout.ts src/composition/layout.test.ts
git commit -m "feat(composition): generic layout engine — aspect planning, register search, balanced measured partition, all theme numbers behind VocabularyMetrics (D71)"
```

---

### Task 4: Dhaba vocabulary package (`src/vocabularies/dhaba/`)

Port the prototype `catalog.ts` into the first real `ComponentVocabulary`. The components are the same five (masthead+frame shell, section header, price list, polaroid photo band with the three modes, group band) plus the continuation cue — with **engine-legal output** deltas.

**Files:**
- Create: `src/vocabularies/dhaba/index.ts`
- Create: `src/vocabularies/index.ts`
- Test: `src/vocabularies/dhaba/dhaba.test.ts`
- Reference: `prototypes/component-vocab/catalog.ts` (port source), `prototypes/component-vocab/fitter.ts` (the `REGISTERS` table + px constants move here)

**Interfaces:**
- Consumes: `ComponentVocabulary` et al. (Task 2).
- Produces: `dhabaVocabulary: ComponentVocabulary` (id `"dhaba"`, version `1`); `builtinVocabularies(): VocabularyRegistry` in `src/vocabularies/index.ts`:

```ts
// src/vocabularies/index.ts — full file
import type { ComponentVocabulary, VocabularyRegistry } from "../ports/vocabulary-registry";
import { dhabaVocabulary } from "./dhaba/index";

/** The engine's built-in theme component packages (D71). Callers may merge their own over these. */
export function builtinVocabularies(
  extra: readonly ComponentVocabulary[] = [],
): VocabularyRegistry {
  return new Map([dhabaVocabulary, ...extra].map((v) => [v.id, v]));
}
```

**Port deltas from `prototypes/component-vocab/catalog.ts` (exhaustive):**
1. **No hardcoded colors.** Delete the `TOKENS` const. Every color already referenced as `var(--color-*)` stays; the four literal rgba inks (`LEADER`, `DIVIDER`, tape `rgba(242,181,58,...)`, shadows) stay as literals — they are alpha composites of theme inks with no token form, and composed HTML is token-lint-exempt (Task 8). The **shell** no longer emits `:root{--color-*}`; instead `renderShell` receives tokens implicitly: declare them from the theme at the painter layer (Task 6 passes `theme.tokens.colors` into a wrapper `<div style="--color-bg:...;--color-text:...">` it builds itself — the vocabulary emits only `var()` references).
   → Concretely: `renderShell` emits the stripe-frame + paper + masthead structure from the prototype's `shell()`/`masthead()`, but the OUTERMOST element must carry `data-composed="dhaba@1"` and **no** CSS-variable declarations, **no** `<!DOCTYPE>`/`<head>`/font `<link>`s (the packager owns the document + fonts).
2. **Images become placeholders.** `polaroidCard` renders `<img data-img-item="${c.id}" data-img-index="0" alt="...">` with NO `src` attribute (packager fills the data-URI — see `src/adapters/tailwind/packager.ts` `inlineItemImages`). `VocabItem.hasImage` replaces the prototype's `imageUrl` presence checks.
3. **Bindings.** `priceRow(...)` stamps `data-item-id="${item.id}"` on the row root. Same for group-band rows (they reuse `priceRow`).
4. **Registers + metrics.** Move the prototype fitter's `REGISTERS` table (all three L/M/S entries, unchanged numbers), `rowH`, `headerH`, `collageBandHeight`, `LINE = 1.25`, and the px shell constants (`FRAME=16, HEADER=96, PAD_TOP=24, PAD_BOTTOM=30, PAD_SIDE=36`) into this file; implement `contentBox`, `metrics(register)` (wrapping those helpers), `minStreamWidth: 430`, `sectionGap: 14`, `landscapeBannerHeight: 224`, `registerNames: ["L","M","S"]`, `defaultPhotoMode: "filmstrip"` (the user's chosen mode).
5. **Interface adaptation.** `renderSection` = prototype `sectionHeader(n,…) + priceList(items, cols, r)` in a `<div>`; `renderGroup` = prototype `triBand`; `renderPhotoBand` = prototype `polaroidCollage` (all three modes, keyframe `uid` scoping kept; `"collage"` mode renamed `"static"`); `renderFlowLead`/`renderFlowRow`/`renderContinuationCue` = the prototype's flow-unit header+first-row pairing, `priceRow`, `continuationCue`. Register objects are looked up internally by name; the interface passes register **names** only.
6. **Brand.** In `renderShell`, when `args.brand` is present, replace the masthead's empty white logo box with `<img data-brand-logo alt="${brand.name ?? ""}" style="height:46px;max-width:170px;object-fit:contain">` (packager inlines the logo data-URI, D18).
7. **promptNotes:**

```ts
promptNotes: {
  section: "a numbered category with dotted-leader price rows (1–3 columns, sized automatically)",
  group: "2–3 SMALL categories side by side in one compact band with vertical dividers — use for categories of ~2–5 items",
  photoBand: "a filmstrip of tilted white polaroid photo cards with captions, cycling through all chosen photos",
},
```

8. **QA-required markers (pipeline compatibility — verified against `src/qa/structural-checks.ts`, do not skip):**
   - The photo band's root element must carry `data-image-slot="shared"`, and a photo band whose items all belong to one section should carry `data-image-slot="<section title>"` — the image-slot presence check (structural-checks.ts ~line 574) fires "image-slot-missing" majors otherwise. Simplest correct behavior: always stamp `data-image-slot="shared"` on the band root (board-level `imageSlot` is what the dhaba plans produce).
   - Read the binding-integrity check + `config.requiredBindings` FIRST and stamp exactly what it requires on each row: at minimum `data-item-id` on the row root and `data-bind="price"` on the price span (a non-whitespace price text is what the check treats as "filled"). Add `data-bind="name"` on the name span if the required-bindings config lists it.
9. **Carousel settled state (screenshot correctness — verified against `src/adapters/playwright/browser.ts`):** the QA browser renders with `reducedMotion: "reduce"` and then force-finishes finite animations; **infinite CSS animations are left running**, and the crossfade deck's keyframes start every layer at `opacity:0` — an un-handled crossfade band screenshots as EMPTY (dead-space false-major, ghost poster). Both carousel modes MUST include a `@media (prefers-reduced-motion: reduce)` block that suspends the animation and shows a settled, representative frame: filmstrip → `animation: none` on the track (cards visible at translateX(0)); crossfade → `animation: none` + first layer forced `opacity:1`. The TV never sets reduced-motion, so live boards still animate — same bytes, honest QA frame (same trade the packaged motion runtime already makes).

- [ ] **Step 1: Write the failing tests**

```ts
// src/vocabularies/dhaba/dhaba.test.ts
import { describe, expect, it } from "vitest";

import { dhabaVocabulary } from "./index";

const items = (n: number, withImages = false) =>
  Array.from({ length: n }, (_, i) => ({
    id: `i${i}`,
    name: `Dish ${i}`,
    price: i % 7 === 0 ? null : 9.99,
    hasImage: withImages,
  }));

describe("dhabaVocabulary", () => {
  it("declares the registry contract", () => {
    expect(dhabaVocabulary.id).toBe("dhaba");
    expect(dhabaVocabulary.registerNames).toEqual(["L", "M", "S"]);
    expect(dhabaVocabulary.defaultPhotoMode).toBe("filmstrip");
  });

  it("renderShell emits a single data-composed root, no document chrome, no hex colors", () => {
    const html = dhabaVocabulary.renderShell({
      title: "Street & Sweets",
      tagline: "Garma Garam!",
      canvas: { width: 1080, height: 1920 },
      register: "M",
      bodyHtml: "<div>BODY</div>",
    });
    expect(html).toMatch(/^<div[^>]*data-composed="dhaba@1"/);
    expect(html).not.toContain("<!DOCTYPE");
    expect(html).not.toContain("<link");
    expect(html).not.toContain(":root");
    expect(html).toContain("var(--color-accent)");
    expect(html).toContain("BODY");
  });

  it("renderSection stamps data-item-id on every row and renders MP for null prices", () => {
    const html = dhabaVocabulary.renderSection({
      number: 1,
      section: { title: "Biryani", items: items(6) },
      internalCols: 2,
      register: "M",
    });
    for (let i = 0; i < 6; i++) expect(html).toContain(`data-item-id="i${i}"`);
    expect(html).toContain(">MP<");
  });

  it("renderPhotoBand (filmstrip) emits src-less data-img-item placeholders and scoped keyframes", () => {
    const html = dhabaVocabulary.renderPhotoBand({
      items: items(4, true),
      register: "M",
      bandHeight: 300,
      bandWidth: 976,
      mode: "filmstrip",
      uid: "b1",
    });
    expect(html).toContain('data-img-item="i0"');
    expect(html).not.toMatch(/<img[^>]*\bsrc=/);
    expect(html).toContain("@keyframes slide_b1");
    expect(html).toContain("mask-image");
  });

  it("photo band carries the image-slot marker and a reduced-motion settled state (QA contract)", () => {
    for (const mode of ["filmstrip", "crossfade"] as const) {
      const html = dhabaVocabulary.renderPhotoBand({
        items: items(4, true),
        register: "M",
        bandHeight: 300,
        bandWidth: 976,
        mode,
        uid: "b1",
      });
      expect(html).toContain('data-image-slot="shared"');
      expect(html).toContain("prefers-reduced-motion");
    }
  });

  it("price rows carry data-bind=\"price\" (binding-integrity contract)", () => {
    const html = dhabaVocabulary.renderSection({
      number: 1,
      section: { title: "Biryani", items: items(3) },
      internalCols: 1,
      register: "M",
    });
    expect(html).toContain('data-bind="price"');
  });

  it("metrics are monotone: more items → taller section; S register ≤ M ≤ L row heights", () => {
    const m = dhabaVocabulary.metrics("M");
    expect(m.sectionHeight(20, 2)).toBeGreaterThan(m.sectionHeight(6, 2));
    expect(dhabaVocabulary.metrics("S").flowRowHeight()).toBeLessThanOrEqual(
      dhabaVocabulary.metrics("M").flowRowHeight(),
    );
    expect(dhabaVocabulary.metrics("M").flowRowHeight()).toBeLessThanOrEqual(
      dhabaVocabulary.metrics("L").flowRowHeight(),
    );
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/vocabularies/dhaba/dhaba.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Port `catalog.ts` → `src/vocabularies/dhaba/index.ts`** applying the seven deltas; create `src/vocabularies/index.ts` exactly as shown in Interfaces.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/vocabularies/dhaba/dhaba.test.ts` → PASS.

- [ ] **Step 5: Gate + commit**

`npm run verify` → green.

```bash
git add src/vocabularies/
git commit -m "feat(vocabularies): dhaba component package — 5 gold-mined components + continuation cue behind ComponentVocabulary; engine-legal output (data-item-id, data-img-item, data-composed) (D71)"
```

---

### Task 5: Generic renderer (`src/composition/renderer.ts`) + measure port

Port the prototype `render.ts`: normalize + coverage guarantee + stack/columns bodies + measured cues — every theme touchpoint through the vocabulary. The measurer becomes part of `BrowserPort`.

**Files:**
- Modify: `src/ports/browser.ts` — add `measure`
- Modify: `src/testing/fakes/browser.ts` — implement `measure` on `ScriptedBrowser`
- Modify: `src/adapters/playwright/browser.ts` — implement `measure`
- Create: `src/composition/renderer.ts`
- Test: `src/composition/renderer.test.ts`
- Reference: `prototypes/component-vocab/render.ts`

**Interfaces:**
- Consumes: Tasks 1–4 exports.
- Produces:

```ts
// added to src/ports/browser.ts
export interface MeasureRequest {
  /** A self-contained HTML document containing data-mk-tagged elements. */
  html: string;
  /** Layout width the measure column is rendered at. */
  width: number;
}
export interface BrowserPort {
  render(request: RenderRequest): Promise<RenderResult>;
  /** Measure each `[data-mk]` element's rendered height (px), keyed by its data-mk value (D72). */
  measure(request: MeasureRequest): Promise<Record<string, number>>;
}
```

```ts
// src/composition/renderer.ts main export
export interface RenderComposedInput {
  composition: CompositionResponse;
  sections: VocabSection[];
  photoCandidates: VocabItem[]; // items eligible for photoBand (imageSlot ∩ hasImage)
  canvas: VocabCanvas;
  tagline: string | null;
  vocab: ComponentVocabulary;
  photoMode: PhotoBandMode;
  brand?: BrandInput;
  measure?: (req: MeasureRequest) => Promise<Record<string, number>>;
  /** Theme color tokens, declared as CSS vars on a wrapper around the shell. */
  colorTokens: Readonly<Record<string, string>>;
  /** Fond family tokens for the measure document (font-dependent heights). */
  fontFamilies: Readonly<Record<string, string>>;
}
export interface RenderComposedResult {
  html: string; // single root element, engine-legal
  finalBlocks: CompositionBlock[];
  fit: FitResult;
  warnings: string[];
  columnPlan?: ColumnPlan; // as in the prototype (diagnostics)
}
export function renderComposed(input: RenderComposedInput): Promise<RenderComposedResult>;
```

**Port deltas from `prototypes/component-vocab/render.ts` (exhaustive):**
1. Every direct component call (`sectionHeader`, `priceList`, `priceRow`, `triBand`, `polaroidCollage`, `continuationCue`, `masthead`, `shell`) → the corresponding `vocab.render*` method; every `REGISTERS`/`Register` use → register **names**; every metric (`collageBandHeight`, `SECTION_GAP`, `LANDSCAPE_BANNER_H`) → `vocab.metrics(register)` / `vocab.sectionGap` / `vocab.landscapeBannerHeight`.
2. Block kinds: `collage` → `photoBand`, `triBand` → `group` (normalize/coverage/expand logic otherwise verbatim, including the "demote a <2-section group to sections" and "append forgotten sections" guarantees and their warning strings).
3. **The wrapper owns tokens:** `renderComposed` wraps the vocabulary's shell in `<div style="${cssVars}">…</div>` where `cssVars` declares `--color-<name>:<value>` for every entry of `colorTokens` — so vocabulary output stays token-pure and the composed root the QA sees is the wrapper (stamp `data-composed` on the wrapper too, copying from the shell's value).
4. **Measure document** (`buildMeasureDoc`): becomes a full standalone document (it goes straight to `BrowserPort.measure`, not the packager): keep `<!DOCTYPE html>`, inline the SAME `cssVars`, and declare `@font-face`-free font-family fallbacks from `fontFamilies` — plus a `<style>` hoist: collect any `<style>` blocks the flow units emitted. Fonts in the measure doc will fall back to system faces in the fake; the Playwright adapter loads packaged fonts is NOT required — heights only need the same font-size/line-height, and a ±2px error is absorbed by the balance slack; document this in a comment. (The prototype loaded Google Fonts; the engine must stay offline — this is the accepted trade, noted in DECISIONS D72.)
5. `Measurer` type is replaced by `(req: MeasureRequest) => Promise<Record<string, number>>` bound from `BrowserPort.measure`.
6. `RenderContext.photoMode` → explicit `photoMode` input (the painter resolves theme default vs config override).
7. Photo resolution (`resolveCollage`) keys on `hasImage` instead of `imageUrl` presence; padding to ≥3 from remaining candidates and the 3–12 clamp stay.

**`ScriptedBrowser.measure` (fake):** deterministic formula — parse the html for `data-mk="..."` occurrences and return `40` for keys whose element contains a `data-flow-lead` marker... **No.** Simpler and honest: the renderer cannot know fake internals; the fake returns a configurable constant per key: `measure()` returns `Object.fromEntries(keys.map(k => [k, k === "__cue__" ? 24 : 28]))` where keys are extracted with `/data-mk="([^"]+)"/g`. Constant heights still exercise partitioning, cues, and balance logic deterministically.

**Playwright `measure`:** new method alongside `render`: `page.setContent(html)`, `await page.evaluate(() => document.fonts.ready)`, then evaluate `Array.from(document.querySelectorAll('[data-mk]')).map(el => [el.getAttribute('data-mk'), el.getBoundingClientRect().height])` into an object. Reuse the existing browser-launch plumbing in `src/adapters/playwright/browser.ts` (read the file; follow how `render` acquires a page).

- [ ] **Step 1: Write the failing tests**

```ts
// src/composition/renderer.test.ts
import { describe, expect, it } from "vitest";

import type { CompositionResponse } from "../domain/contracts";
import { dhabaVocabulary } from "../vocabularies/dhaba/index";
import { renderComposed } from "./renderer";

const secs = (spec: Array<[string, number, boolean?]>) =>
  spec.map(([title, n, img]) => ({
    title,
    items: Array.from({ length: n }, (_, i) => ({
      id: `${title}-${i}`,
      name: `${title} dish ${i}`,
      price: 9.99,
      hasImage: Boolean(img),
    })),
  }));

const base = {
  sections: secs([["Dosa", 7, true], ["Desserts", 15], ["Chaat", 2], ["Hot Drinks", 4]]),
  photoCandidates: secs([["Dosa", 7, true]])[0]!.items,
  canvas: { width: 1080, height: 1920 },
  tagline: "Garma Garam!",
  vocab: dhabaVocabulary,
  photoMode: "filmstrip" as const,
  colorTokens: { bg: "#f8ecd4", text: "#2a1a0e", accent: "#c22415", price: "#c22415", chip: "#0d6e5c", surface: "#ffffff", muted: "#57503f", stripe: "#f2b53a" },
  fontFamilies: { display: "Shrikhand", body: "Archivo" },
};

const comp: CompositionResponse = {
  title: "Street & Sweets",
  blocks: [
    { kind: "section", section: "Dosa", sections: [], itemIds: [] },
    { kind: "photoBand", section: "", sections: [], itemIds: ["Dosa-0", "Dosa-1", "Dosa-2"] },
    { kind: "group", section: "", sections: ["Chaat", "Hot Drinks"], itemIds: [] },
  ],
};

describe("renderComposed", () => {
  it("guarantees coverage: appends sections the composition forgot (Desserts)", async () => {
    const res = await renderComposed({ ...base, composition: comp });
    expect(res.warnings.join(" ")).toContain("Desserts");
    expect(res.html).toContain('data-item-id="Desserts-0"');
    // every item of every section is bound exactly once
    for (const s of base.sections) for (const it of s.items) expect(res.html).toContain(`data-item-id="${it.id}"`);
  });

  it("emits a single token-declaring composed root and no external chrome", async () => {
    const res = await renderComposed({ ...base, composition: comp });
    expect(res.html).toMatch(/^<div[^>]*data-composed=/);
    expect(res.html).toContain("--color-accent:#c22415");
    expect(res.html).not.toContain("<link");
    expect(res.html).not.toMatch(/<img[^>]*\bsrc=/);
  });

  it("landscape: partitions into measured columns and stamps continuation cues", async () => {
    const measured: string[] = [];
    const res = await renderComposed({
      ...base,
      canvas: { width: 1920, height: 1080 },
      composition: comp,
      measure: async ({ html }) => {
        measured.push(html);
        const keys = [...html.matchAll(/data-mk="([^"]+)"/g)].map((m) => m[1]!);
        return Object.fromEntries(keys.map((k) => [k, k === "__cue__" ? 24 : 30]));
      },
    });
    expect(measured).toHaveLength(1);
    expect(res.columnPlan?.columns).toBeGreaterThanOrEqual(2);
    // 28 flow rows at 30px across ≥2 columns must split at least one section → ≥1 cue
    expect(res.columnPlan?.cues.length).toBeGreaterThanOrEqual(1);
    expect(res.html).toContain("(cont.)");
  });

  it("drops a group with <2 known sections to plain sections with a warning", async () => {
    const res = await renderComposed({
      ...base,
      composition: {
        title: "X",
        blocks: [{ kind: "group", section: "", sections: ["Chaat", "Nope"], itemIds: [] }],
      },
    });
    expect(res.warnings.join(" ")).toContain("group");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/composition/renderer.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement** — add `measure` to `BrowserPort` + `ScriptedBrowser` (formula above) + the Playwright adapter; port `render.ts` → `renderComposed` with the seven deltas.

- [ ] **Step 4: Run tests + the full suite** (the `BrowserPort` change ripples into existing fakes/tests — fix all compile errors; `ScriptedBrowser` gaining a method breaks nothing behaviorally).

Run: `npx vitest run src/composition/renderer.test.ts` → PASS, then `npm run verify` → green.

- [ ] **Step 5: Commit**

```bash
git add src/ports/browser.ts src/testing/fakes/browser.ts src/adapters/playwright/browser.ts src/composition/renderer.ts src/composition/renderer.test.ts
git commit -m "feat(composition): generic renderer (coverage guarantee, stack/columns, measured continuation cues) + BrowserPort.measure (D72)"
```

---

### Task 6: Digest builder + CompositionPainter (core orchestration)

The core class that makes composition a drop-in `Painter`. Pure orchestration over injected ports; no adapter imports.

**Files:**
- Create: `src/composition/digest.ts`
- Create: `src/composition/painter.ts`
- Test: `src/composition/painter.test.ts`

**Interfaces:**
- Consumes: `Painter`/`PaintRequest` (existing), `Composer` (Task 2), `renderComposed` (Task 5), `builtinVocabularies` shape (Task 4).
- Produces:

```ts
// src/composition/digest.ts
export interface ComposerContent {
  sections: VocabSection[];
  photoCandidates: VocabItem[];
  digest: string;          // section/item lines + photo library (prototype loadContent format)
  vocabularyPrompt: string; // block-kind contract + vocab.promptNotes lines
}
export function buildComposerContent(args: {
  planScreen: PlanScreen;
  items: CanonicalItem[];
  vocab: ComponentVocabulary;
}): ComposerContent;
```

```ts
// src/composition/painter.ts
export class CompositionPainter implements Painter {
  constructor(
    private readonly deps: {
      composer: Composer;
      vocabularies: VocabularyRegistry;
      browser: Pick<BrowserPort, "measure">;
      logger?: Logger;
      /** Override every theme's default photo mode (config knob); undefined = theme default. */
      photoMode?: PhotoBandMode;
    },
  ) {}
  async paint(request: PaintRequest): Promise<string>;
}
```

**Behavior spec for `paint()` (implement exactly):**
1. `const vocabId = request.theme.vocabulary` — the `vocabulary` theme-schema field is added in THIS task (see below), so this compiles.
2. Missing vocabulary id or unregistered id → throw `PaintError` (`src/domain/errors.ts`) with code preserved — the AutoPainter (this task) prevents reaching here for free themes.
3. Build sections/photoCandidates/digest/vocabularyPrompt via `buildComposerContent` — sections from `planScreen.sections` joined to `items` by id (name cleaned of a trailing `" *"` marker, price `?? null`, `hasImage` = item images non-empty), photoCandidates = `planScreen.imageSlot.items ∩ items-with-images`.
4. `composer.compose({...})` with `canvas` = `request.viewport ?? { width: 1080, height: 1920 }` and, when `request.findings?.length`, a `findingsNote` = bulleted findings messages (re-compose instead of HTML repair).
5. `renderComposed(...)` with `photoMode` = `deps.photoMode ?? vocab.defaultPhotoMode`, `colorTokens` = `request.theme.tokens.colors`, `fontFamilies` = `request.theme.tokens.fontFamilies`, `brand` = `request.brand`, `measure` bound from `deps.browser`, `tagline` = `request.brand?.tagline ?? null`.
6. Log render warnings via `logger.warn` (board-tagged like paintNode's existing message style); return `result.html`.

```ts
// src/composition/auto-painter.ts
/** Routes each paint to the composition path when the theme names a registered vocabulary
 *  (and mode !== "free"), else to the free painter. Pure; both painters are injected. */
export class AutoPainter implements Painter {
  constructor(
    private readonly deps: {
      free: Painter;
      composition: Painter;
      vocabularies: VocabularyRegistry;
      mode: "auto" | "free" | "composition";
    },
  ) {}
  async paint(request: PaintRequest): Promise<string> {
    const { mode, vocabularies, free, composition } = this.deps;
    const vocabId = request.theme.vocabulary;
    const hasVocab = vocabId !== undefined && vocabularies.get(vocabId) !== undefined;
    if (mode === "composition" || (mode === "auto" && hasVocab)) return composition.paint(request);
    return free.paint(request);
  }
}
```

**Theme schema field (do it in this task so everything compiles together):** in `src/domain/schemas.ts`, add to `themePresetObjectSchema`:

```ts
  /**
   * Names the registered ComponentVocabulary that renders this theme via the composition path
   * (D71). Absent → the theme paints via the free painter. Resolution/fallback is AutoPainter's.
   */
  vocabulary: z.string().min(1).optional(),
```

(`resolvedThemeSchema` extends the same object schema, so it inherits the field.)

- [ ] **Step 1: Write the failing tests**

```ts
// src/composition/painter.test.ts
import { describe, expect, it } from "vitest";

import type { CompositionResponse } from "../domain/contracts";
import type { PaintRequest, Painter } from "../ports/index";
import { fixtures } from "../testing/index"; // read src/testing/ to pick the real fixture export for a PlanScreen+items+theme trio
import { builtinVocabularies } from "../vocabularies/index";
import { AutoPainter } from "./auto-painter";
import { CompositionPainter } from "./painter";

const staticComposition: CompositionResponse = { title: "Test Board", blocks: [] };

const fakeComposer = () => {
  const calls: unknown[] = [];
  return {
    calls,
    compose: async (req: unknown) => {
      calls.push(req);
      return staticComposition;
    },
  };
};

const fakeMeasure = {
  measure: async ({ html }: { html: string }) => {
    const keys = [...html.matchAll(/data-mk="([^"]+)"/g)].map((m) => m[1]!);
    return Object.fromEntries(keys.map((k) => [k, 28]));
  },
};

// Build a minimal PaintRequest from the repo fixtures with theme.vocabulary = "dhaba".
// (Adjust to the actual fixture names found in src/testing/fixtures — the intent is locked:
//  a real PlanScreen with ≥2 sections + matching CanonicalItems + the dhaba-like theme.)
declare function makeRequest(overrides?: { vocabulary?: string }): PaintRequest;

describe("CompositionPainter", () => {
  it("composes then renders an engine-legal board with full coverage", async () => {
    const composer = fakeComposer();
    const painter = new CompositionPainter({
      composer,
      vocabularies: builtinVocabularies(),
      browser: fakeMeasure,
    });
    const html = await painter.paint(makeRequest({ vocabulary: "dhaba" }));
    expect(html).toMatch(/data-composed=/);
    expect(composer.calls).toHaveLength(1);
    // coverage guarantee: empty composition still renders every planned item
    expect(html).toContain("data-item-id=");
  });

  it("passes findings as a re-compose note on iteration >0", async () => {
    const composer = fakeComposer();
    const painter = new CompositionPainter({
      composer,
      vocabularies: builtinVocabularies(),
      browser: fakeMeasure,
    });
    const req = makeRequest({ vocabulary: "dhaba" });
    await painter.paint({
      ...req,
      findings: [{ /* one QaFinding fixture: severity "major", message "photo band overflows" … */ } as never],
    });
    expect(JSON.stringify(composer.calls[0])).toContain("photo band overflows");
  });
});

describe("AutoPainter", () => {
  const probe = (): Painter & { hits: number } => {
    const p = {
      hits: 0,
      paint: async () => {
        p.hits += 1;
        return "<div></div>";
      },
    };
    return p;
  };

  it("auto mode: vocabulary theme → composition; plain theme → free", async () => {
    const free = probe();
    const composition = probe();
    const auto = new AutoPainter({ free, composition, vocabularies: builtinVocabularies(), mode: "auto" });
    await auto.paint(makeRequest({ vocabulary: "dhaba" }));
    await auto.paint(makeRequest());
    expect(composition.hits).toBe(1);
    expect(free.hits).toBe(1);
  });

  it("free mode forces the free painter even for vocabulary themes", async () => {
    const free = probe();
    const composition = probe();
    const auto = new AutoPainter({ free, composition, vocabularies: builtinVocabularies(), mode: "free" });
    await auto.paint(makeRequest({ vocabulary: "dhaba" }));
    expect(free.hits).toBe(1);
    expect(composition.hits).toBe(0);
  });
});
```

**Implementer note:** replace `declare function makeRequest` with a real helper built from `src/testing/fixtures` (read `src/testing/index.ts` for the exported fixture names — the repo has canonical items + plan + theme fixtures used by `engine.test.ts`). The helper spreads `{ vocabulary: overrides?.vocabulary }` conditionally (exactOptionalPropertyTypes).

- [ ] **Step 2: Run tests to verify they fail** — `npx vitest run src/composition/painter.test.ts` → FAIL (modules missing).

- [ ] **Step 3: Implement** `digest.ts` (port the prototype `loadContent`/`SYSTEM` digest format: section lines `Section "T" (n): name $p; …` + photo library lines `id = name`; vocabularyPrompt = the block-kind contract sentences from the prototype SYSTEM prompt, with per-kind `vocab.promptNotes` appended), `painter.ts` per the behavior spec, `auto-painter.ts` as shown, and the `vocabulary` theme-schema field.

- [ ] **Step 4: Run tests + gate** — `npx vitest run src/composition` → PASS; `npm run verify` → green.

- [ ] **Step 5: Commit**

```bash
git add src/composition/ src/domain/schemas.ts
git commit -m "feat(composition): CompositionPainter + AutoPainter behind the Painter port; digest builder; theme schema gains vocabulary field (D71)"
```

---

### Task 7: OpenRouter composer adapter + `compose` model role

**Files:**
- Modify: `src/config/models.ts`
- Create: `src/adapters/openrouter/composer.ts`
- Test: `src/adapters/openrouter/composer.test.ts` (hermetic, mocked client — mirror `planner.test.ts`)
- Reference: `src/adapters/openrouter/planner.ts` (the adapter pattern to mirror), `src/adapters/openrouter/client.ts`

**Interfaces:**
- Consumes: `Composer`/`ComposeRequest` (Task 2), `compositionResponseSchema` (Task 1), the OpenRouter client's structured-call helper (read `client.ts`; use the same JSON-schema call path the planner uses, including correlation stamping and usage telemetry).
- Produces: `OpenRouterComposer implements Composer` (constructor mirrors `OpenRouterPlanner`'s: client + model + reasoning options).

**Config changes (`src/config/models.ts`):**
1. `modelRoleSchema` → `z.enum(["plan", "paint", "critique", "repair", "compose"])`.
2. Roles object: `compose: z.string().min(1).default("anthropic/claude-sonnet-5")`.
3. Add `"compose"` to the set of roles validated against `structuredOutputAllowlist` (find where `plan`/`critique`/`repair` are checked; `paint` is exempt — `compose` is NOT exempt).
4. Reasoning defaults: `compose: reasoningSettingSchema.prefault({ enabled: false })` (composition is a small judgment call; measured prototype latency 4–9s without reasoning).

**Adapter behavior:** system prompt = the prototype `SYSTEM` constant reworked to read canvas dimensions + orientation from the request (`You are the composer for a menu POSTER (${w}×${h} ${orientation})…`), the JUDGMENT-ONLY contract sentences, and `request.vocabularyPrompt`; user message = `request.digest` (+ `\n\nQA found these problems with your previous composition:\n${findingsNote}\nReturn a corrected composition.` when present); `response_format` = strict JSON schema from `z.toJSONSchema(compositionResponseSchema)` named `"composition"`; one Zod-validation retry with the error appended (the planner adapter has this pattern — reuse its helper if one exists, else copy the loop).

- [ ] **Step 1: Write the failing test** — mirror `src/adapters/openrouter/planner.test.ts`'s mocked-client structure: assert (a) the request carries `response_format.json_schema.strict === true` and the schema root is an object with `title`+`blocks`; (b) a valid response parses to a `CompositionResponse`; (c) an invalid-then-valid response sequence triggers exactly one retry with the validation error in the second request's messages; (d) correlation headers/metadata flow through like the planner's. Copy the planner test's mock scaffolding verbatim and adapt names — read that file first.

- [ ] **Step 2: Run to verify failure** — `npx vitest run src/adapters/openrouter/composer.test.ts` → FAIL.

- [ ] **Step 3: Implement config changes + adapter.**

- [ ] **Step 4: Run** `npx vitest run src/adapters/openrouter src/config` → PASS; `npm run verify` → green.

- [ ] **Step 5: Commit**

```bash
git add src/config/models.ts src/adapters/openrouter/composer.ts src/adapters/openrouter/composer.test.ts
git commit -m "feat(adapters): OpenRouterComposer with strict structured outputs + compose model role (sonnet-5 default, allowlist-checked) (D71)"
```

---

### Task 8: QA — trust composed markup (token-lint, matrix contract, critic size directive)

Composed HTML is deterministic renderer output: px sizes and alpha-composite inks are correct by construction, and the LLM never touched them. Three checks were written for the *free* painter and must adapt for `data-composed` boards while keeping free-paint behavior byte-identical:

1. **token-lint** skips composed roots (raw-px/hex constraints target LLM-authored markup).
2. **matrix-structure check** skips composed roots: v1 vocabularies render `representation: "matrix"` sections as price lists (no `data-matrix-cell` DOM), so the fixed-table contract would fire a major UNFIXABLE finding every iteration → routing rule 92 → re-paint loop → budget burn → freeze flagged. Coverage + binding integrity (which still run) already guarantee every item present with a price; the matrix DOM contract is a free-paint contract. (The combo/matrix component in vocabulary v2 re-enables it.)
3. **vision-critic size directive**: `visionQaNode` briefs the critic with `sizeDirectiveFor(...)` — the free-painter's rem targets. A composed board was sized by the fitter's register search, not the directive, so the critic would grade against numbers the board never received (false "type too small" findings). When the candidate HTML root carries `data-composed`, the visionQA node omits `sizeDirective` (and keeps `densityTier` — it describes content, not painter instructions).

**Files:**
- Modify: `src/qa/structural-checks.ts` (token-lint + matrix-structure check entry points; both parse HTML already)
- Modify: `src/pipeline/nodes/index.ts` (visionQA brief: conditional sizeDirective — ~line 294, the `layoutStrategy` assembly)
- Test: extend the existing structural-checks test file + `engine.test.ts` (find `token-lint` / matrix describe blocks; add cases)

**Interfaces:**
- Consumes: the `data-composed` root marker (Tasks 4/5).
- Produces: no signature changes — behavior only. Export a tiny shared helper `isComposedHtml(html: string): boolean` from `src/qa/structural-checks.ts` (root-element attribute test via node-html-parser) so the node and both checks share one definition.

- [ ] **Step 1: Write the failing tests** (in the existing structural-checks test file, matching its local helpers/style — read it first):

```ts
it("token-lint SKIPS markup whose root carries data-composed (deterministic renderer output)", () => {
  const html = `<div data-composed="dhaba@1"><div style="color:#c22415;font-size:19px">x</div></div>`;
  const findings = runTokenLint(html, defaultTokenLintRules()); // adapt to the file's actual API
  expect(findings).toHaveLength(0);
});

it("token-lint still fires on free-paint markup (no marker)", () => {
  const html = `<div><div style="color:#c22415">x</div></div>`;
  const findings = runTokenLint(html, defaultTokenLintRules());
  expect(findings.length).toBeGreaterThan(0);
});
```

Also add (matrix + critic brief):

```ts
it("matrix-structure check SKIPS composed roots (v1 vocabularies render matrix sections as lists)", () => {
  // plan section with matrix data + composed html WITHOUT data-matrix DOM → no findings
});
it("matrix-structure check still fires on free-paint markup missing matrix cells", () => {
  // existing fixture, no data-composed → finding present (non-regression pin)
});
```

And in `engine.test.ts` (composition describe block from Task 9 — write it there if this task lands first):

```ts
it("visionQA brief omits sizeDirective for composed boards", async () => {
  // ScriptedVisionCritic captures its CritiqueRequest; assert layoutStrategy does not
  // contain the rem-target directive text for a data-composed candidate.
});
```

- [ ] **Step 2: Run to verify the new cases fail** (non-regression pins already pass).

- [ ] **Step 3: Implement**: add `isComposedHtml`; token-lint returns `[]` for composed roots (comment cites D73: "deterministic vocabulary output is trusted; the lint's target is LLM-authored markup"); matrix-structure check returns `[]` for composed roots (comment cites the v1 list-rendering limitation + rule-92 loop rationale); visionQA node spreads `...(isComposedHtml(state.html) ? {} : { sizeDirective })` into the brief assembly.

- [ ] **Step 4: Run the qa + pipeline suites** — `npx vitest run src/qa src/pipeline` → PASS; `npm run verify` → green.

- [ ] **Step 5: Commit**

```bash
git add src/qa/ src/pipeline/nodes/index.ts src/pipeline/engine.test.ts
git commit -m "feat(qa): composed-board trust — token-lint + matrix contract skip data-composed roots; critic brief drops free-paint size directive (D73)"
```

---

### Task 9: Fakes + fake-engine wiring + e2e scenario

Make the composition path first-class in the hermetic test harness, then prove the full pipeline end-to-end with fakes: vocabulary theme → composed paint → package → QA → freeze, and the fallback path for a plain theme.

**Files:**
- Create: `src/testing/fakes/composer.ts` (`FakeComposer`: returns a scripted `CompositionResponse` sequence, clamped to last — mirror `ScriptedVisionCritic`'s pattern)
- Modify: `src/testing/fakes/index.ts` — export it; extend `createFakeEngine` options with `{ composer?, vocabularies?, paintMode? }`, defaulting to `FakeComposer` + `builtinVocabularies()` + `"auto"`, and wire `AutoPainter` around the existing `FakePainter`
- Test: `src/pipeline/engine.test.ts` — add a describe block
- Reference: `src/testing/fakes/painter.ts`, `src/pipeline/engine.test.ts` (scenario style: `cleanObservation()` etc.)

**Interfaces:**
- Consumes: everything from Tasks 1–8.
- Produces: `FakeComposer` (constructor `(script?: CompositionResponse[])`), `createFakeEngine` accepting the new options.

- [ ] **Step 1: Write the failing e2e tests** (adapt fixture/theme names to the file's existing helpers — read it first; the intent is locked):

```ts
describe("composition paint path (D71)", () => {
  it("a vocabulary theme paints via composition: composed root ships, QA passes, coverage holds", async () => {
    const { engine } = createFakeEngine({
      // theme fixture cloned with vocabulary: "dhaba"; scripted clean observation
    });
    const result = await engine.generate(/* fixture input for that theme */);
    const screen = result.screens[0]!;
    expect(screen.html).toContain("data-composed=");
    expect(result.qaReport.screens[0]!.passed).toBe(true);
    // every planned item id appears as a data-item-id binding
  });

  it("a theme WITHOUT a vocabulary still free-paints (fallback intact)", async () => {
    const { engine, painterSpy } = createFakeEngine({ /* plain theme */ });
    const result = await engine.generate(/* fixture input */);
    expect(result.screens[0]!.html).not.toContain("data-composed=");
  });

  it("QA findings on a composed board re-compose (composer sees findingsNote)", async () => {
    // ScriptedBrowser: deadSpaceObservation() then cleanObservation();
    // FakeComposer scripted with two compositions; assert compose called twice and
    // the second request's findingsNote mentions the dead-space finding.
  });
});
```

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement** `FakeComposer` + `createFakeEngine` wiring (AutoPainter with mode from options; `ScriptedBrowser` already has `measure` from Task 5).

- [ ] **Step 4: Run** `npx vitest run src/pipeline/engine.test.ts` → PASS; `npm run verify` → green.

- [ ] **Step 5: Commit**

```bash
git add src/testing/ src/pipeline/engine.test.ts
git commit -m "test(e2e): composition path through the full fake pipeline — composed paint, QA convergence via re-compose, free-paint fallback (D71)"
```

---

### Task 10: Node root wiring + config + theme flag

**Files:**
- Modify: `src/config/painter.ts` — add `mode: z.enum(["auto", "free", "composition"]).default("auto")` with a doc comment (composition requires `ports.composer` + a registered vocabulary; `auto` = per-theme)
- Modify: `src/adapters/node-engine.ts` — construct `OpenRouterComposer` (role `compose`), `builtinVocabularies()`, `CompositionPainter`, and wrap the existing `OpenRouterPainter` in `AutoPainter` with `config.painter.mode`
- Modify: `themes/dhaba.theme.json` — add `"vocabulary": "dhaba"` (top level, next to `"id"`)
- Modify: `scripts/try.ts` — add `compose: "anthropic/claude-sonnet-5"` to the models block (match the file's existing role entries)
- Test: `src/adapters/node-engine.test.ts` — extend (it already tests wiring without keys); `src/theme/theme-files.test.ts` — theme file still parses (existing test will cover the new field via schema; add an assertion that dhaba declares `vocabulary: "dhaba"`)

- [ ] **Step 1: Write failing assertions** — node-engine test: creating the engine yields a painter that is an `AutoPainter` (export a discriminating marker or test via behavior: paint-mode `free` config still constructs); theme test: `expect(dhaba.vocabulary).toBe("dhaba")`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement all four file changes.** In `node-engine.ts`, `CompositionPainter`'s `browser` dep is the same Playwright `BrowserPort` instance already constructed for QA — reuse it, do not launch a second browser.

- [ ] **Step 4: Run** `npm run verify` → green.

- [ ] **Step 5: Commit**

```bash
git add src/config/painter.ts src/adapters/node-engine.ts themes/dhaba.theme.json scripts/try.ts src/adapters/node-engine.test.ts src/theme/theme-files.test.ts
git commit -m "feat(node): wire composition path — compose role, builtin vocabularies, AutoPainter; dhaba theme opts in via vocabulary field (D71)"
```

---

### Task 11: Live validation run (gated; needs OPENROUTER_API_KEY)

Not a unit-test task — the acceptance gate before docs. **Do not skip.**

- [ ] **Step 1: Portrait run** — `(setopt null_glob; rm -f real-output/screen-*; true) && npm run try -- samples/menu-dhaba-2board.json --preset=dhaba --aspect=9:16 --screens=2 --verbose`
Expected: both boards freeze `passed: true`; console shows the paint step completing in seconds (composition, not free paint); `real-output/screen-*.html` contains `data-composed="dhaba@1"` and **zero** `http`/`https` URLs (offline check: `grep -c "https\?://" real-output/screen-1.html` → only inside data URIs, i.e. `grep -Eo 'src="http[^"]*"' real-output/screen-1.html | wc -l` → 0).

- [ ] **Step 2: Landscape run** — same command with `--aspect=16:9`. Expected: measured columns + continuation cues visible in the poster PNGs; no overflow findings in the reports.

- [ ] **Step 3: Inspect the posters visually** (Read the PNGs). Compare against `eval-loop/gold-3b.png` and `prototypes/component-vocab/out/cont-mains-landscape/board.png` for idiom fidelity. Fix regressions before proceeding (iterate within this task).

- [ ] **Step 4: Commit any fixes**

```bash
git add -A && git commit -m "fix(composition): live-run corrections from dhaba portrait+landscape validation"
```

---

### Task 12: Decisions + architecture docs

- [ ] **Step 1: Append to `DECISIONS.md`** (follow the file's D-entry format exactly; read the tail first):
  - **D71** — Composition paint path: closed component vocabulary; engine-owned 3-kind composition contract; theme-owned pluggable `ComponentVocabulary` packages behind `VocabularyRegistry`; `AutoPainter` per-theme selection with free-paint fallback; composer = judgment only, layout engine = all arithmetic; coverage guaranteed in the renderer (mirrors `coverage.ts`).
  - **D72** — `BrowserPort.measure` + measured-column landscape flow with continuation cues; measure doc uses fallback faces offline (±2px absorbed by balance slack).
  - **D73** — token-lint exemption for `data-composed` roots; rationale (lint targets LLM-authored markup; renderer output is deterministic and pixel-tested).
  - **D74** — Board titles: the composition `title` is sanctioned invented copy (human board names like "Street & Sweets"); item-level copy remains data-bound only (photo-truth unchanged).
- [ ] **Step 2: Add an ARCHITECTURE.md section** ("Composition paint path") with the three-layer diagram from this plan's header and the file map.
- [ ] **Step 3: Update CLAUDE.md** briefly: the paint role now has two paths; vocabulary themes compose (cheap, deterministic), plain themes free-paint; mention `config.painter.mode`.
- [ ] **Step 4: Commit**

```bash
git add DECISIONS.md ARCHITECTURE.md CLAUDE.md
git commit -m "docs: D71–D74 composition paint path — vocabulary packages, measure port, token-lint trust, sanctioned board titles"
```

---

## Deliberately out of scope (backlog, do NOT build now)

- **featureCard / combo / multi-price components** — vocabulary v2; the interface accommodates new block kinds only via a contract version bump (engine-owned enum), which is intentional friction.
- **Pixel-test matrix** (component × register × content shape via `measure`/screenshot snapshots) — after the path ships.
- **Shared token names across themes; second theme vocabulary; fork-and-extract onboarding** — Phase 3 (per the roadmap discussion).
- **Retiring the free painter** — it stays as the fallback for the five vocabulary-less themes indefinitely.
- **Matrix representation**: plan sections with `representation: "matrix"` render as price lists in v1 (known limitation; combo/matrix component is the v2 flagship).

## Pipeline-compatibility review (verified against source, already folded into tasks)

Checks that need NO change for composed boards (verified): contrast/overflow/density rendered checks (real observations, fitter targets ≥92% fill vs the 0.4 minFill floor), binding-integrity + image-slot presence (the vocabulary emits the required markers — T4 delta 8), motion-vocab lint (scans `data-motion`, which composed boards don't use; CSS keyframes are invisible to it), self-contained/no-baked-player (packager output unchanged), router/scoring/freeze (findings-driven, path-agnostic), repairs (deterministic contrast token-swap + overflow shrink work on composed HTML too — inline `var()` styles are what the repair emits anyway).

Checks that DO adapt (folded into T8): token-lint (skip composed), matrix-structure (skip composed — v1 renders matrix sections as lists; without the skip, rule-92 re-paint loops burn the budget), visionQA sizeDirective (omit for composed — the board was sized by the register search, not the free-painter rem directive). Screenshot settling (reducedMotion + finish()) is handled at the SOURCE: carousels ship a `prefers-reduced-motion` settled state (T4 delta 9) so the QA frame is honest without adapter changes.

## Self-review notes (already applied)

- Spec coverage: contract ✓ (T1), pluggable theme packages + interface ✓ (T2/T4), separation of concerns ✓ (layout T3 / renderer T5 / orchestration T6 / adapter T7), engine integration behind Painter ✓ (T6/T9/T10), QA adjustment ✓ (T8), offline/photo inlining via existing packager placeholders ✓ (T4 delta 2, T11 check), production validation ✓ (T11), docs ✓ (T12).
- Type consistency: `PhotoBandMode` (`static|crossfade|filmstrip`) used in T2/T4/T5/T6; block kinds `section|group|photoBand` everywhere; `partitionColumns(units, columns, cueH)` signature preserved from prototype; register passed as **string name** through all vocab methods.
- Known intentional simplifications called out inline: measure-doc fonts (T5 delta 4), matrix-as-list (out of scope), findings→re-compose instead of HTML repair (T6).
