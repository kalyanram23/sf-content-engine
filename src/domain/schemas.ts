import { z } from "zod";

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
});

export const planImageSlotSchema = z.object({
  categoryId: z.string().optional(),
  items: z.array(z.string().min(1)),
});

export const planScreenSchema = z.object({
  id: z.string().min(1),
  imageSlot: planImageSlotSchema.optional(),
  sections: z.array(planSectionSchema).min(1),
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

export const qaScreenReportSchema = z.object({
  screenId: z.string(),
  passed: z.boolean(),
  /** Shipped despite not passing because the iteration budget was exhausted (§5.6). */
  flagged: z.boolean(),
  iterations: z.number().int().nonnegative(),
  score: z.number(),
  findings: z.array(qaFindingSchema),
  /** Routing decision per iteration — debuggability surface (§5.7). */
  routeHistory: z.array(z.string()),
});

export const qaReportSchema = z.object({
  screens: z.array(qaScreenReportSchema),
  passedAll: z.boolean(),
  generatedAt: z.string(),
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
