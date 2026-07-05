import { z } from "zod";

import { severitySchema } from "../domain/schemas";
import { deepFreeze } from "../util/freeze";

export const rubricDimensionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  weight: z.number().positive(),
  /** A finding at/above this severity fails the dimension. */
  failAtSeverity: severitySchema,
  /**
   * When true, this dimension failing (at/above `failAtSeverity`) fails the whole pass on its
   * own — regardless of the weighted score. Absent/false everywhere by default: turning it on
   * for a craft-critical dimension (e.g. hierarchy) is a config decision, not an engine change.
   */
  blocking: z.boolean().optional(),
});

/**
 * Vision rubric (spec §5.6). Doubles as the critic's structured-output dimension set and
 * the scoring weights. `passThreshold` is the minimum weighted score (0–1) to pass the
 * vision pass.
 */
export const visionRubricConfigSchema = z.object({
  dimensions: z
    .array(rubricDimensionSchema)
    .min(1)
    .default([
      {
        id: "balance",
        description:
          "Visual balance across the whole frame — no dead space (a large contiguous empty region, " +
          "an empty band or hero zone above the content inside a card, or a bottom half/quarter left " +
          "blank) and no crowding; content should fill the canvas, not cluster in one region floating " +
          "in a void.",
        weight: 1,
        failAtSeverity: "major",
      },
      {
        id: "hierarchy",
        description: "Clear visual hierarchy and reading order.",
        weight: 1,
        failAtSeverity: "major",
      },
      {
        id: "theme-adherence",
        description:
          "Matches the DESIGN INTENT brief (identity, palette roles, motif) — not just any pleasant design.",
        weight: 0.75,
        failAtSeverity: "major",
      },
      {
        id: "representation-clarity",
        description: "The chosen representation reads clearly for the data shape.",
        weight: 1,
        failAtSeverity: "major",
      },
      {
        id: "intentional-design",
        description:
          "Looks intentionally designed for THIS theme (see DESIGN INTENT), not AI-generic or " +
          "templated — and uses the screen real estate on purpose: no content marooned in empty " +
          "space, no card sized for a photo or description that isn't there.",
        weight: 0.75,
        failAtSeverity: "major",
      },
      {
        id: "decoration-legibility",
        description: "Decoration never harms legibility across a room.",
        weight: 1,
        failAtSeverity: "minor",
      },
    ]),
  /**
   * Minimum weighted score to pass. 0.7 means any TWO failed dimensions fail the board (two
   * weight-1 failures score 3.5/5.5 ≈ 0.64) while a single failure still passes (worst single
   * weight-1 failure scores 4.5/5.5 ≈ 0.82) — at the old 0.6, a board failing both hierarchy
   * AND intentional-design (3.75/5.5 ≈ 0.68) still shipped as "passed".
   */
  passThreshold: z.number().min(0).max(1).default(0.7),
});

export type RubricDimension = z.infer<typeof rubricDimensionSchema>;
export type VisionRubricConfig = z.infer<typeof visionRubricConfigSchema>;

export const defaultRubric = (): VisionRubricConfig =>
  deepFreeze(visionRubricConfigSchema.parse({}));
