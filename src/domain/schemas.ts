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
});

export const themeAssetsSchema = z.object({
  backgrounds: z.array(themeAssetSchema).default([]),
  fonts: z.array(themeFontSchema).default([]),
});

/** A vetted preset bundle: tokens + motion vocabulary + assets (spec §5.3). */
export const themePresetSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  /**
   * The theme's base painter prompt — its creative + design direction (voice, layout posture,
   * visual identity). Externalized per-theme (e.g. `themes/<id>.theme.json`) so authoring a
   * theme is editing one file. The engine appends a non-negotiable technical contract
   * (bindings, offline-safety, motion vocab, the photo-placeholder scheme) the painter must
   * always honour, so a theme controls the look/voice but can't break the rails.
   */
  prompt: z.string().optional(),
  tokens: themeTokensSchema,
  /** The motion vocabulary — single source of truth for the motion-vocab lint (D14). */
  motion: z.array(motionPresetSchema).min(1),
  assets: themeAssetsSchema.default({ backgrounds: [], fonts: [] }),
});

/** A preset with brief perturbations applied — what the painter actually paints against. */
export const resolvedThemeSchema = themePresetSchema.extend({
  density: densitySchema,
  motif: z.string().optional(),
});

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

/* ------------------------------------------------------------------ generate() I/O (§3) */

export const generateInputSchema = z.object({
  items: z.array(canonicalItemSchema).min(1),
  brief: themeBriefSchema,
  /** `prefault({})` lets an omitted `constraints` flow through and pick up field defaults. */
  constraints: generateConstraintsSchema.prefault({}),
  /** Optional hand-authored plan (v1, §5.4). When absent the `Planner` port produces it. */
  plan: thinPlanSchema.optional(),
});

export const generateOutputSchema = z.object({
  screens: z.array(selfContainedScreenSchema),
  posters: z.array(posterSchema),
  qaReport: qaReportSchema,
});
