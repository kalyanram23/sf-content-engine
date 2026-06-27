import { z } from "zod";

import { severitySchema } from "../domain/schemas";
import { deepFreeze } from "../util/freeze";

export const rubricDimensionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  weight: z.number().positive(),
  /** A finding at/above this severity fails the dimension. */
  failAtSeverity: severitySchema,
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
        description: "Visual balance; no dead space or crowding.",
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
        description: "Adheres to the resolved theme tokens and motif.",
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
        description: "Looks intentionally designed, not AI-generic.",
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
  passThreshold: z.number().min(0).max(1).default(0.6),
});

export type RubricDimension = z.infer<typeof rubricDimensionSchema>;
export type VisionRubricConfig = z.infer<typeof visionRubricConfigSchema>;

export const defaultRubric = (): VisionRubricConfig =>
  deepFreeze(visionRubricConfigSchema.parse({}));
