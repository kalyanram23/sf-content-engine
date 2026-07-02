import { z } from "zod";

import { severitySchema } from "../domain/schemas";
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
   * Severity of the under-fill finding. `major` (default) drives a re-paint — the spec's
   * acceptance #1 behaviour; tune to `minor` to make dead space advisory and let the vision
   * critic own the "is this emptiness intentional?" judgment.
   */
  underFillSeverity: severitySchema.default("major"),
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

export const qaConfigSchema = z.object({
  viewport: viewportConfigSchema.prefault({}),
  contrast: contrastConfigSchema.prefault({}),
  density: densityConfigSchema.prefault({}),
  legibility: legibilityConfigSchema.prefault({}),
  /** Slack (px) before a box past the viewport edge counts as overflow. */
  overflowTolerancePx: z.number().min(0).default(1),
  /** Findings at/above this severity block a pass (and so drive the QA loop). */
  blockingSeverity: severitySchema.default("major"),
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
