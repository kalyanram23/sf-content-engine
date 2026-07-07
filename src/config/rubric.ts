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
          "an empty band or hero zone above the content inside a card, an awkward void between a " +
          "card's description and its price, or a bottom half/quarter left blank) and no crowding; " +
          "content should fill the canvas, not cluster in one region floating in a void.",
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
          "space, no card sized for a photo or description that isn't there, no content pushed to " +
          "opposite edges of a card leaving a gap between a description and its price.",
        weight: 0.75,
        failAtSeverity: "major",
      },
      {
        id: "decoration-legibility",
        description: "Decoration never harms legibility across a room.",
        weight: 1,
        failAtSeverity: "minor",
      },
      {
        id: "invented-copy",
        description:
          "Prominent text not traceable to the menu data, the board title, or the provided brand — " +
          "fabricated restaurant names, filler badge chips ('PRICE LIST', 'USD', 'MADE TO ORDER', " +
          "'DINE IN · TAKEOUT'), invented taglines or operational claims. A theme's internal name " +
          "appearing as on-screen copy is an automatic fail.",
        weight: 0.75,
        failAtSeverity: "major",
      },
    ]),
  /**
   * Minimum weighted score to pass. With the default dimensions (total weight 6.25), 0.7 means
   * any TWO failed weight-1 dimensions fail the board (two weight-1 failures score 4.25/6.25 ≈
   * 0.68) while a single failure still passes (worst single weight-1 failure scores 5.25/6.25 ≈
   * 0.84) — 0.7 over the old 0.6 so two co-occurring craft failures can no longer ship as
   * "passed".
   */
  passThreshold: z.number().min(0).max(1).default(0.7),
});

export type RubricDimension = z.infer<typeof rubricDimensionSchema>;
export type VisionRubricConfig = z.infer<typeof visionRubricConfigSchema>;

export const defaultRubric = (): VisionRubricConfig =>
  deepFreeze(visionRubricConfigSchema.parse({}));
