import { z } from "zod";

import { representationSchema, severitySchema } from "../domain/schemas";
import { deepFreeze } from "../util/freeze";

/** Target display geometry — Chromium must render at these EXACT pixels + DPR (§5.6a). */
export const viewportConfigSchema = z.object({
  width: z.number().int().positive().default(1920),
  height: z.number().int().positive().default(1080),
  dpr: z.number().positive().default(1),
});

/** WCAG contrast thresholds (hard gate, §10.4) + the large-text boundaries. */
export const contrastConfigSchema = z.object({
  minNormal: z.number().positive().default(4.5),
  minLarge: z.number().positive().default(3.0),
  /** Regular text ≥ this px counts as "large" for WCAG. */
  largeTextPx: z.number().positive().default(24),
  /** Bold text ≥ this px counts as "large". */
  largeBoldPx: z.number().positive().default(18.66),
});

/** Density bounds — flag too-empty (dead space) or too-crammed screens (§5.6). */
export const densityConfigSchema = z.object({
  minFill: z.number().min(0).max(1).default(0.4),
  maxFill: z.number().min(0).max(1).default(0.9),
  /**
   * Boards with at most this many planned items are held to `sparseMinFill` instead of
   * `minFill`: an intentionally airy 3-item hero board is a design choice, not dead space,
   * and must not burn the whole iteration budget failing a floor meant for full menus.
   */
  sparseItemCount: z.number().int().positive().default(6),
  sparseMinFill: z.number().min(0).max(1).default(0.25),
  /**
   * Representations that read as TYPE-LED — a price table/ladder legitimately breathes with
   * whitespace, so a board dominated by these is held to the relaxed `typeLedMinFill` under-fill
   * floor instead of `minFill` (§ Phase 5). The over-fill bound stays universal. A board carrying a
   * computed `matrix` is always treated as type-led regardless of this list.
   */
  typeLedRepresentations: z.array(representationSchema).default(["matrix", "list"]),
  /**
   * Under-fill floor for a type-led board — deliberately low (a comparison table is meant to have
   * air). Set to 0 to disable the under-fill check for type-led boards entirely.
   */
  typeLedMinFill: z.number().min(0).max(1).default(0.2),
  /**
   * Severity of the under-fill finding. `major` (default) drives a re-paint — the spec's
   * acceptance #1 behaviour; tune to `minor` to make dead space advisory and let the vision
   * critic own the "is this emptiness intentional?" judgment.
   */
  underFillSeverity: severitySchema.default("major"),
  /**
   * Severity of the OVER-fill finding on a PLAN-FORCED dense board (D26): the plan allocated more
   * rows than the canvas's comfortable budget (an atomic oversized category, D25), so density is a
   * fact the painter cannot fix — grading it `major` burns the whole iteration budget on an
   * impossible demand. Default `minor`: the board passes with a warning-level note. Boards within
   * budget keep the universal `major` over-fill severity.
   */
  planForcedOverFillSeverity: severitySchema.default("minor"),
});

/**
 * Legibility floors (px) for item-bound text at ~10–20 ft viewing. Deliberately BELOW the
 * painter contract's target (text-lg/16px+) so the check catches genuine shrink-to-fit
 * escapes without re-paint-storming borderline boards. Matrix price tables legitimately run
 * smaller, so their cells get a relaxed floor.
 */
export const legibilityConfigSchema = z.object({
  /** Floor for text inside an item node (name/price/description). */
  itemMinPx: z.number().positive().default(14),
  /** Relaxed floor for item text in a `matrix` section (dense price tables). */
  matrixItemMinPx: z.number().positive().default(12),
});

/**
 * Overflow shrink-to-fit repair bound (D31). When rendered content extends past the viewport, a
 * pure deterministic repair (`src/repairs`) scales the content root by a computed fit factor rather
 * than re-asking the painter (which reliably re-overflows). `minShrinkFactor` bounds that mechanism:
 * a fit that would need to scale below this floor signals a real allocation/layout problem better
 * fixed by a re-paint (or re-plan) than papered over by shrinking the whole board to a crawl — so
 * such an overflow is left NOT deterministically fixable and escalates to the LLM path.
 */
export const overflowRepairConfigSchema = z.object({
  minShrinkFactor: z.number().min(0).max(1).default(0.5),
});

/**
 * Image-geometry thresholds (§ Phase 4). Guards food photos from two failure modes the plain
 * "did it load?" check missed: distortion (a `fill`/`none` image squished off its natural aspect)
 * and over-cropping (a `cover` image in an extreme band that slices the photo).
 */
export const imageGeometryConfigSchema = z.object({
  /** Relative aspect deviation (0–1) above which a `fill`/`none` image counts as distorted. */
  distortionTolerance: z.number().min(0).default(0.15),
  /**
   * Max container:natural (or natural:container) aspect-ratio factor before a `cover` image is
   * over-cropped. 2.2 trips a ~4:3 photo forced into a >3.5:1 hero band.
   */
  maxCropFactor: z.number().min(1).default(2.2),
});

export const qaConfigSchema = z.object({
  viewport: viewportConfigSchema.prefault({}),
  contrast: contrastConfigSchema.prefault({}),
  density: densityConfigSchema.prefault({}),
  legibility: legibilityConfigSchema.prefault({}),
  image: imageGeometryConfigSchema.prefault({}),
  overflowRepair: overflowRepairConfigSchema.prefault({}),
  /** Slack (px) before a box past the viewport edge counts as overflow. */
  overflowTolerancePx: z.number().min(0).default(1),
  /** Findings at/above this severity block a pass (and so drive the QA loop). */
  blockingSeverity: severitySchema.default("major"),
  /**
   * Skip the paid, image-carrying vision critique on any iteration a deterministic finding
   * already GATE-BLOCKS (§5.6, D27): a candidate with a finding at/above `blockingSeverity` (or a
   * hard gate) can never pass this iteration, and that same blocking finding already selects the
   * repair/re-paint route — so the critique is pure spend (~1.1k image tokens + up to ~2MB
   * payload) whose verdict cannot change the outcome. Set `false` to restore critic feedback on
   * blocked iterations (the legacy hard-gate-only skip).
   */
  skipVisionWhenBlocking: z.boolean().default(true),
  /** Dynamic bindings every item node must expose (§5.5, D8 — data-driven). */
  requiredBindings: z.array(z.string().min(1)).default(["price"]),
  /** Max items a representation can hold per section before re-plan escalation (§5.6, S1). */
  capacities: z
    .record(z.string(), z.number().int().positive())
    .default({ matrix: 6, "variant-rows": 8, grid: 8, list: 12 }),
});

export type ViewportConfig = z.infer<typeof viewportConfigSchema>;
export type ContrastConfig = z.infer<typeof contrastConfigSchema>;
export type DensityConfig = z.infer<typeof densityConfigSchema>;
export type LegibilityConfig = z.infer<typeof legibilityConfigSchema>;
export type OverflowRepairConfig = z.infer<typeof overflowRepairConfigSchema>;
export type ImageGeometryConfig = z.infer<typeof imageGeometryConfigSchema>;
export type QaConfig = z.infer<typeof qaConfigSchema>;

export const defaultQaConfig = (): QaConfig => deepFreeze(qaConfigSchema.parse({}));

/** The render geometry for a screen aspect — 16:9 landscape, 9:16 portrait (DPR 1). */
export function viewportForAspect(aspect: "16:9" | "9:16"): {
  width: number;
  height: number;
  dpr: number;
} {
  return aspect === "9:16"
    ? { width: 1080, height: 1920, dpr: 1 }
    : { width: 1920, height: 1080, dpr: 1 };
}

/**
 * Orient the configured viewport to the requested aspect (D19): aspect — a per-request constraint —
 * owns ORIENTATION, while `qa.viewport` owns RESOLUTION (1080p vs 4K) and DPR. When the configured
 * viewport's orientation disagrees with the requested aspect, width/height are swapped (dpr passes
 * through); a square viewport is left untouched. This is what makes a `constraints.aspect: "9:16"`
 * request actually render portrait for every caller, not just `scripts/try.ts`.
 */
export function orientViewport(viewport: ViewportConfig, aspect: "16:9" | "9:16"): ViewportConfig {
  const wantPortrait = aspect === "9:16";
  const isPortrait = viewport.height > viewport.width;
  if (viewport.width === viewport.height || wantPortrait === isPortrait) return viewport;
  return { width: viewport.height, height: viewport.width, dpr: viewport.dpr };
}
