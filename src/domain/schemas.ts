import { z } from "zod";

import { contentEngineErrorCodeSchema } from "./errors";

/**
 * Domain schemas — Zod is the single source of truth; types are inferred (see types.ts).
 * These describe the engine's public input/output and internal value objects. Strict
 * LLM request/response contracts live separately in contracts.ts (DECISIONS D2).
 */

/* ------------------------------------------------------------------ menu input */

/** A size/price cell, e.g. pizza 10″ → 14.99. Drives the `matrix` representation. */
export const itemSizeSchema = z.object({
  label: z.string().min(1),
  price: z.number().nonnegative(),
});

/** A protein/option variant, e.g. Paneer / Chicken. Drives the `variant-rows` representation. */
export const itemVariantSchema = z.object({
  label: z.string().min(1),
  price: z.number().nonnegative().optional(),
});

/** A normalized menu item from the upstream normalizer. Referenced everywhere by `id`. */
export const canonicalItemSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  /** Base price; may be absent when the item is priced per-size. */
  price: z.number().nonnegative().optional(),
  category: z.string().optional(),
  available: z.boolean().default(true),
  sizes: z.array(itemSizeSchema).optional(),
  variants: z.array(itemVariantSchema).optional(),
  /** Image references (data-URIs or URLs); the packager inlines them offline-safe. */
  images: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});

/* ------------------------------------------------------------------ brief + constraints */

/** Density dial — perturbs the resolved theme's spacing posture (spec §5.3). */
export const densitySchema = z.enum(["compact", "balanced", "airy"]);

/** A theme brief: start from a preset and perturb it (spec §5.3). */
export const themeBriefSchema = z.object({
  presetId: z.string().min(1),
  /** Token overrides (e.g. `{ "color.accent": "#8a9a5b" }`) applied over the preset. */
  palette: z.record(z.string(), z.string()).optional(),
  density: densitySchema.optional(),
  motif: z.string().optional(),
  notes: z.string().optional(),
  /** Restaurant/menu name. Used only for observability correlation (Broadcast session id + trace). */
  restaurant: z.string().optional(),
});

export const generateConstraintsSchema = z.object({
  /** Landscape (16:9) or portrait (9:16); drives the render viewport. */
  aspect: z.enum(["16:9", "9:16"]).default("16:9"),
  /** Spec type is `number | "auto"`; the coverage planner fits all items into this many screens. */
  screens: z.union([z.number().int().positive(), z.literal("auto")]).default(1),
  locale: z.string().default("en-US"),
  currency: z.string().default("USD"),
});

/* ------------------------------------------------------------------ thin plan (content IR, §5.4) */

export const representationSchema = z.enum(["matrix", "variant-rows", "grid", "list"]);

/**
 * A cross-category comparison matrix COMPUTED at plan time (never returned by an LLM — this is
 * bookkeeping code owns, mirroring the coverage guarantee). `columns` are the block's category
 * names (e.g. `["Biryani","Pulav"]`); each row is a shared base dish and `cells[i]` is the
 * canonical item id for `columns[i]`, or `null` (rendered as an em-dash) when that column has no
 * match. Every item in the block appears in exactly ONE cell (asserted in `buildMatrix`). Distinct
 * from the per-item size/price `matrix` REPRESENTATION (pizza 8″/10″/12″), which the representation
 * oracle handles.
 */
export const sectionMatrixSchema = z.object({
  columns: z.array(z.string().min(1)).min(1),
  rows: z.array(
    z.object({
      label: z.string().min(1),
      /** One entry per column: the item id at that column, or null for an em-dash cell. */
      cells: z.array(z.string().min(1).nullable()),
    }),
  ),
});

/**
 * A per-category (per-section) visual anchor, synthesized by `expandLayoutToPlan` on a comfortable,
 * non-matrix board so every category gets its own image slot (the category-images requirement).
 * `kind: "photos"` carries up to a handful of that category's photo-item ids (a real photo
 * panel/carousel); `kind: "icon"` carries an empty `items` and directs the painter to render a
 * deliberate themed FOOD-ICON illustration panel for a category whose items have no photos — NOT a
 * missing/broken-photo look. NOT an LLM contract field: the planner LLM never emits slots (they are
 * synthesized in pure code, D2), so this optional addition is safe on the internal `thinPlan`.
 */
export const planSectionImageSlotSchema = z.object({
  kind: z.enum(["photos", "icon"]),
  /** Photo-item ids for `kind: "photos"`; empty for `kind: "icon"`. */
  items: z.array(z.string().min(1)),
});

export const planSectionSchema = z.object({
  title: z.string().min(1),
  representation: representationSchema,
  /** Canonical item IDs allocated to this section. */
  items: z.array(z.string().min(1)).min(1),
  /**
   * Optional free-text layout direction for the painter (e.g. "price table: rows = base dish,
   * columns = Biryani | Pulav"). The painter free-paints from it; no fixed structure required.
   */
  layoutHint: z.string().optional(),
  /**
   * Optional computed comparison matrix (see {@link sectionMatrixSchema}). Attached by
   * `expandLayoutToPlan` when the block combines multiple categories or is a `matrix`
   * representation. NOT an LLM contract field — `thinPlan` is never sent to a model as a strict
   * JSON schema (only `planLayout` is), so an optional field with a `null` union inside is safe.
   */
  matrix: sectionMatrixSchema.optional(),
  /**
   * Optional per-category image slot (see {@link planSectionImageSlotSchema}). Attached by
   * `expandLayoutToPlan` to every section of a comfortable, non-matrix board. Optional so
   * hand-authored plans keep validating; not an LLM contract field.
   */
  imageSlot: planSectionImageSlotSchema.optional(),
});

export const planImageSlotSchema = z.object({
  categoryId: z.string().optional(),
  items: z.array(z.string().min(1)),
});

/**
 * Deterministic density tier (D30) — how a board's row/item load compares to the per-canvas
 * legibility budget: `comfortable` (≤ budget), `dense` (≤ `packedMultiplier`×budget), `packed`
 * (beyond). Computed by `expandLayoutToPlan` and stamped on each screen so the painter switches to a
 * progressively more compact price-list idiom and the critic judges a dense board AS a dense board.
 * Optional: a hand-authored plan never carries it, so consumers recompute it from the board's rows
 * when absent. NOT an LLM contract field — `thinPlan` is never sent to a model as a strict JSON
 * schema (only `planLayout` is), so an added optional enum is safe (mirrors the `matrix` field, D20).
 */
export const densityTierSchema = z.enum(["comfortable", "dense", "packed"]);

export const planScreenSchema = z.object({
  id: z.string().min(1),
  /**
   * The board's masthead title — its section titles joined with " · " (e.g. "Mandi · Non Veg
   * Appetizers"). Stamped deterministically by `expandLayoutToPlan` so every screen of a set has a
   * stable title the painter renders in the masthead band. Optional so hand-authored plans keep
   * validating; not an LLM contract field (`thinPlan` is never sent to a model as a strict schema).
   */
  title: z.string().min(1).optional(),
  imageSlot: planImageSlotSchema.optional(),
  sections: z.array(planSectionSchema).min(1),
  /** Computed density tier (see {@link densityTierSchema}); optional for hand-authored plans. */
  densityTier: densityTierSchema.optional(),
});

export const thinPlanSchema = z.object({
  screens: z.array(planScreenSchema).min(1),
});

/* ------------------------------------------------------------------ layout blueprints (D17) */

/**
 * When a blueprint applies to a board. All present fields must hold (AND) — except
 * `representationAnyOf`/`layoutHintPattern`, which form one OR'd section test: the board
 * qualifies when ANY section's representation is listed OR its layoutHint matches the pattern
 * (mirrors the legacy matrix-board detection).
 */
export const blueprintAppliesWhenSchema = z.object({
  representationAnyOf: z.array(representationSchema).optional(),
  /** Case-insensitive regex source tested against section layoutHints. */
  layoutHintPattern: z.string().optional(),
  /** Bounds on the board's total planned item count. */
  minItems: z.number().int().positive().optional(),
  maxItems: z.number().int().positive().optional(),
  /** Bounds on the board's section count. */
  minSections: z.number().int().positive().optional(),
  maxSections: z.number().int().positive().optional(),
  /** Minimum number of items on the board that carry a photo. */
  minPhotoItems: z.number().int().positive().optional(),
});

/**
 * A named golden layout (hyperframes "frame treatment" adapted to static signage): selection
 * rules + the LAYOUT STRATEGY prose the painter renders from, split into FIXED invariants
 * (visual-only — NEVER count-reducing; item coverage is separately guaranteed by the
 * binding-integrity check) and FREE judgment calls. Selection is pure code at paint time —
 * the planner's LLM contract is untouched.
 */
export const layoutBlueprintSchema = z.object({
  id: z.string().min(1),
  /** Higher wins; the first matching blueprint by descending priority is selected. */
  priority: z.number().int(),
  appliesWhen: blueprintAppliesWhenSchema.prefault({}),
  /** The strategy prose rendered into the painter prompt (and shown to the vision critic). */
  strategy: z.string().min(1),
  /** Non-negotiable visual invariants, rendered as "FIXED (do not change)". */
  fixed: z.array(z.string().min(1)).default([]),
  /** Explicitly the painter's judgment, rendered as "FREE (your call)". */
  free: z.array(z.string().min(1)).default([]),
  /**
   * Optional theme-agnostic HTML skeleton establishing the REQUIRED DOM shape (the `data-*`
   * attributes the deterministic checks + runtime patcher rely on) the painter must fill for this
   * layout. Structure ONLY — no sizes or colours; Tailwind theme-token classes stay the painter's
   * job. Rendered into the painter prompt as a FIXED shape when the board carries the matching
   * structured data (e.g. a section `matrix`).
   */
  skeleton: z.string().min(1).optional(),
});

/* ------------------------------------------------------------------ theme (rails, §5.2/§5.3) */

export const motionPresetSchema = z.object({
  name: z.string().min(1),
  /** `css` = trivial fade/entrance (no runtime); `runtime` = orchestrated Motion (§5.2). */
  kind: z.enum(["css", "runtime"]),
  description: z.string().optional(),
  params: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});

export const themeTokensSchema = z.object({
  colors: z.record(z.string(), z.string()),
  fontFamilies: z.record(z.string(), z.string()),
  radius: z.record(z.string(), z.string()),
  // No fontSizes/spacing scale: this is a free-paint engine — type/spacing FEEL is directed by
  // the theme's `prompt` (e.g. "large type, generous margins"), not a fixed token scale, which
  // either inverts Tailwind's scale or makes the painter over-cram.
});

export const themeAssetSchema = z.object({
  id: z.string().min(1),
  /** A self-contained data-URI (offline-safe, §5.1). */
  dataUri: z.string().min(1),
});

export const themeFontSchema = z.object({
  family: z.string().min(1),
  dataUri: z.string().min(1),
  /**
   * The `font-weight` this face carries (e.g. "400", "700"). Optional; defaults to `normal` in
   * the @font-face. Themes that embed two faces of the SAME family at different weights (e.g. a
   * body face at 500 and 700) MUST set this, or both faces collide at `normal` and the bold never
   * renders.
   */
  weight: z.string().min(1).optional(),
});

export const themeAssetsSchema = z.object({
  backgrounds: z.array(themeAssetSchema).default([]),
  fonts: z.array(themeFontSchema).default([]),
});

/**
 * A gold exemplar board (D66) — a finished, hand-vetted screen in this theme, shown to the painter
 * as a "this is what great looks like" STRUCTURE reference (frame, masthead, section/row anatomy,
 * photo treatment, full-height balance). Purely additive prompt content: the painter takes layout
 * and craft moves from it but NEVER its placeholder copy (real items come from the plan), and adapts
 * proportions when the target aspect differs. `html` MUST itself be engine-legal — no raw hex/px,
 * tokens as var(--color-*) — so the exemplar never teaches the exact violations token-lint rejects
 * (pinned by a token-lint test over every theme file's exemplar).
 */
export const themeExemplarSchema = z.object({
  /** The exemplar board's own aspect; the painter adapts proportions if the target differs. */
  aspect: z.enum(["16:9", "9:16"]),
  /** The finished screen markup (a single root element), engine-legal under token-lint. */
  html: z.string().min(1),
  /** Optional one-line authoring note surfaced above the exemplar in the prompt. */
  note: z.string().optional(),
});

/**
 * Structured design direction — the frame.md-inspired split of the old single `prompt` blob
 * into named, individually consumable fields. `identity` feeds the painter as the creative
 * core; `do`/`dont` are rendered as explicit lists for the painter AND handed to the vision
 * critic (so "theme-adherence" is graded against declared intent). Keep `dont` entries
 * VISUALLY checkable ("no sharp corners"), not token-value assertions — palette enforcement
 * stays with the deterministic token-lint.
 */
export const themeDesignSchema = z.object({
  /** The theme's visual identity + decoration voice — the creative core of the painter prompt. */
  identity: z.string().min(1),
  /** Positive theme-specific direction, rendered as a DO list. */
  do: z.array(z.string().min(1)).default([]),
  /** Theme-specific anti-patterns, rendered as a DON'T list and shown to the critic. */
  dont: z.array(z.string().min(1)).default([]),
  /** Optional gold exemplar board (see {@link themeExemplarSchema}); shown to the painter as a
   * structure reference. Optional everywhere — no theme is required to carry one. */
  exemplar: themeExemplarSchema.optional(),
});

/**
 * A reusable signage component recipe (hyperframes "components-as-recipes" adapted to menus).
 * `binds` maps a slot name to a THEME TOKEN name (e.g. `{ bg: "surface-strong", text: "text" }`);
 * every bound name must resolve to a declared token — validated at LOAD time so a typo fails
 * loudly (a theme-authoring error), not silently at paint. `rule` is the scarcity/usage prose
 * fed to the painter (e.g. "one specials ribbon per board; diet badge never larger than the
 * dish name"). Purely painter guidance — no data-component output contract in v1.
 */
export const componentRecipeSchema = z.object({
  id: z.string().min(1),
  /** What the component IS, e.g. "price pill", "diet badge", "specials ribbon". */
  role: z.string().min(1),
  /** slot → theme token name (resolved to a value for the painter; validated at load). */
  binds: z.record(z.string(), z.string()).default({}),
  /** Scarcity/usage constraint prose the painter honours. */
  rule: z.string().min(1),
});

/** A vetted preset bundle: tokens + motion vocabulary + assets (spec §5.3). */
export const themePresetObjectSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /**
   * LEGACY: the theme's painter prompt as one prose blob. Superseded by `design` (structured
   * fields); kept as a fallback so existing third-party theme files load unchanged. When both
   * are present, `design` wins and `prompt` is ignored (no two-source drift).
   */
  prompt: z.string().optional(),
  design: themeDesignSchema.optional(),
  tokens: themeTokensSchema,
  /** The motion vocabulary — single source of truth for the motion-vocab lint (D14). */
  motion: z.array(motionPresetSchema).min(1),
  /**
   * Optional per-theme layout blueprints, merged OVER the engine catalog by id (replace or
   * add) — mirrors how FileThemeRepository overrides bundled presets (D14 precedent). Lets a
   * theme curate layouts coherent with its own composition voice.
   */
  layouts: z.array(layoutBlueprintSchema).optional(),
  /** Optional reusable component recipes (see {@link componentRecipeSchema}). */
  components: z.array(componentRecipeSchema).optional(),
  assets: themeAssetsSchema.default({ backgrounds: [], fonts: [] }),
});

/**
 * Assert every component `binds` value names a declared token (colors ∪ radius ∪ fontFamilies).
 * Runs at parse time so a malformed theme fails loudly at load, not at paint (D14-style
 * authoring guard). Shared by the preset and resolved-theme schemas.
 */
function validateComponentBinds(
  preset: z.infer<typeof themePresetObjectSchema>,
  ctx: z.RefinementCtx,
): void {
  if (!preset.components) return;
  const known = new Set([
    ...Object.keys(preset.tokens.colors),
    ...Object.keys(preset.tokens.radius),
    ...Object.keys(preset.tokens.fontFamilies),
  ]);
  preset.components.forEach((component, i) => {
    for (const [slot, tokenName] of Object.entries(component.binds)) {
      if (!known.has(tokenName)) {
        ctx.addIssue({
          code: "custom",
          message: `component "${component.id}" binds ${slot} → "${tokenName}", which is not a declared token.`,
          path: ["components", i, "binds", slot],
        });
      }
    }
  });
}

export const themePresetSchema = themePresetObjectSchema.superRefine(validateComponentBinds);

/** A preset with brief perturbations applied — what the painter actually paints against. */
export const resolvedThemeSchema = themePresetObjectSchema
  .extend({
    density: densitySchema,
    motif: z.string().optional(),
  })
  .superRefine(validateComponentBinds);

/* ------------------------------------------------------------------ QA findings + report (§5.6) */

export const severitySchema = z.enum(["info", "minor", "major", "critical"]);
export const findingSourceSchema = z.enum(["deterministic", "vision"]);
/** Routing hint (spec §5.6): layout/content come from the critic; mechanical/structural from checks. */
export const findingTagSchema = z.enum(["layout", "content", "mechanical", "structural"]);

/**
 * A single QA finding. `kind` is a free string (not an enum) so new checks and rubric
 * dimensions are data, not a schema edit (rules-as-data). Well-known kinds are exported
 * as `DeterministicKind` constants in qa/.
 */
export const qaFindingSchema = z.object({
  kind: z.string().min(1),
  source: findingSourceSchema,
  severity: severitySchema,
  tag: findingTagSchema,
  message: z.string(),
  region: z.string().optional(),
  itemId: z.string().optional(),
  /** Structured payload (e.g. `{ ratio, required }`, `{ plannedCount, slotCount }`). */
  data: z.record(z.string(), z.unknown()).optional(),
  /** Hard gates (e.g. WCAG contrast) can never pass and sort strictly worst (§10.4). */
  hardGate: z.boolean().default(false),
  /** True when a deterministic transform can fix it without the painter (§5.6 routing). */
  deterministicallyFixable: z.boolean().default(false),
});

/**
 * A terminal per-board failure captured by the generate() bulkhead (D28). When a board's pipeline
 * throws an unrecoverable error (PaintError after all retries, RenderError, LlmContractError, …)
 * the other boards still complete and ship; the failed board carries this on its report and NO
 * screen/poster is emitted for it. `code` is the stable {@link ContentEngineError} code.
 */
export const qaScreenErrorSchema = z.object({
  code: contentEngineErrorCodeSchema,
  message: z.string(),
});

export const qaScreenReportSchema = z.object({
  screenId: z.string(),
  passed: z.boolean(),
  /** Shipped despite not passing because the iteration budget was exhausted (§5.6). */
  flagged: z.boolean(),
  iterations: z.number().int().nonnegative(),
  /**
   * The INTERNAL comparator total (higher is better) — an encoded lexicographic order (hard gate,
   * blocked, penalty, rubric), NOT a human fraction. Show a person {@link rubricScore} instead.
   */
  score: z.number(),
  /** The human-meaningful weighted rubric pass fraction in [0,1] (spec §5.6 vision pass). */
  rubricScore: z.number().min(0).max(1),
  /** Summed severity penalty of all findings (lower is better). */
  penalty: z.number().nonnegative(),
  findings: z.array(qaFindingSchema),
  /** Routing decision per iteration — debuggability surface (§5.7). */
  routeHistory: z.array(z.string()),
  /**
   * Present ONLY when the board failed terminally (bulkhead, D28). `qaReport.screens` is the
   * authoritative per-board record keyed by `screenId`; the screens/posters arrays hold only the
   * boards that succeeded, so a consumer joins on `screenId` and treats `error !== undefined` as
   * "no artifact shipped for this board".
   */
  error: qaScreenErrorSchema.optional(),
});

/**
 * A single menu data-quality lint finding (D29) — the INPUT-side sanity layer. `kind` is a free
 * string (rules-as-data, mirroring {@link qaFindingSchema}); the well-known kinds are exported as
 * `MenuLintKind` constants in `planning/menu-lint`. Engine report state, NOT an LLM contract.
 */
export const menuLintFindingSchema = z.object({
  kind: z.string().min(1),
  /** The offending item's canonical id. */
  itemId: z.string(),
  message: z.string(),
  /** The item's category, when set — disambiguates a `duplicate-name` within its category. */
  category: z.string().optional(),
});

export const qaReportSchema = z.object({
  screens: z.array(qaScreenReportSchema),
  passedAll: z.boolean(),
  generatedAt: z.string(),
  /**
   * Run-level menu data-quality lint findings (D29). Present only when `config.menuLint.mode` is
   * not `"off"` AND the menu had at least one issue — an omitted field means "lint clean" (or off).
   * Surfaced so callers/evals can see what the input menu was flagged for (e.g. a `$0.00` price).
   */
  menuLint: z.array(menuLintFindingSchema).optional(),
});

/* ------------------------------------------------------------------ outputs (§3/§5.1) */

export const selfContainedScreenSchema = z.object({
  id: z.string(),
  /** Self-contained, offline-safe HTML+JS (inline CSS/JS/fonts/assets). */
  html: z.string(),
  /** Canonical IDs bound in this screen — the data-contract surface for the patcher. */
  itemIds: z.array(z.string()),
  meta: z.object({
    presetId: z.string(),
    aspect: z.string(),
    width: z.number().int().positive(),
    height: z.number().int().positive(),
  }),
});

export const posterSchema = z.object({
  screenId: z.string(),
  /** Base64-encoded PNG (1920×1080 by default). */
  pngBase64: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
});

/* ------------------------------------------------------------------ brand (D18) */

/** A brand logo source: a data: URI, an http(s) URL, or a local fs path. The Node composition
 * root resolves URL/path to a data-URI before the pure core sees it (hermetic boundary). */
export const brandLogoSchema = z.object({
  src: z.string().min(1),
  /** Accessibility / fallback text for the logo image. */
  alt: z.string().optional(),
});

/** Optional per-run brand content, rendered as a header band on every screen. Brand *colour*
 * is intentionally NOT here — `brief.palette` token overrides already cover it (D18). */
export const brandInputSchema = z.object({
  logo: brandLogoSchema.optional(),
  name: z.string().min(1).optional(),
  tagline: z.string().min(1).optional(),
});

/* ------------------------------------------------------------------ generate() I/O (§3) */

export const generateInputSchema = z.object({
  items: z.array(canonicalItemSchema).min(1),
  brief: themeBriefSchema,
  /** `prefault({})` lets an omitted `constraints` flow through and pick up field defaults. */
  constraints: generateConstraintsSchema.prefault({}),
  /** Optional hand-authored plan (v1, §5.4). When absent the `Planner` port produces it. */
  plan: thinPlanSchema.optional(),
  /** Optional brand content (logo + name/tagline) rendered as a header band (D18). */
  brand: brandInputSchema.optional(),
});

export const generateOutputSchema = z.object({
  screens: z.array(selfContainedScreenSchema),
  posters: z.array(posterSchema),
  qaReport: qaReportSchema,
});
