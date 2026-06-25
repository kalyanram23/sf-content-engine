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
  maxFill: z.number().min(0).max(1).default(0.85),
});

export const qaConfigSchema = z.object({
  viewport: viewportConfigSchema.prefault({}),
  contrast: contrastConfigSchema.prefault({}),
  density: densityConfigSchema.prefault({}),
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
export type QaConfig = z.infer<typeof qaConfigSchema>;

export const defaultQaConfig = (): QaConfig => deepFreeze(qaConfigSchema.parse({}));
