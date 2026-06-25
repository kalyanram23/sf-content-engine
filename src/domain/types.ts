import type { z } from "zod";

import type {
  canonicalItemSchema,
  densitySchema,
  findingSourceSchema,
  findingTagSchema,
  generateConstraintsSchema,
  generateInputSchema,
  generateOutputSchema,
  itemSizeSchema,
  itemVariantSchema,
  motionPresetSchema,
  planScreenSchema,
  planSectionSchema,
  posterSchema,
  qaFindingSchema,
  qaReportSchema,
  qaScreenReportSchema,
  representationSchema,
  resolvedThemeSchema,
  selfContainedScreenSchema,
  severitySchema,
  themeBriefSchema,
  themePresetSchema,
  themeTokensSchema,
  thinPlanSchema,
} from "./schemas";

export type ItemSize = z.infer<typeof itemSizeSchema>;
export type ItemVariant = z.infer<typeof itemVariantSchema>;
export type CanonicalItem = z.infer<typeof canonicalItemSchema>;

export type Density = z.infer<typeof densitySchema>;
export type ThemeBrief = z.infer<typeof themeBriefSchema>;
export type GenerateConstraints = z.infer<typeof generateConstraintsSchema>;

export type Representation = z.infer<typeof representationSchema>;
export type PlanSection = z.infer<typeof planSectionSchema>;
export type PlanScreen = z.infer<typeof planScreenSchema>;
export type ThinPlan = z.infer<typeof thinPlanSchema>;

export type MotionPreset = z.infer<typeof motionPresetSchema>;
export type ThemeTokens = z.infer<typeof themeTokensSchema>;
export type ThemePreset = z.infer<typeof themePresetSchema>;
export type ResolvedTheme = z.infer<typeof resolvedThemeSchema>;

export type Severity = z.infer<typeof severitySchema>;
export type FindingSource = z.infer<typeof findingSourceSchema>;
export type FindingTag = z.infer<typeof findingTagSchema>;
export type QaFinding = z.infer<typeof qaFindingSchema>;
export type QaScreenReport = z.infer<typeof qaScreenReportSchema>;
export type QaReport = z.infer<typeof qaReportSchema>;

export type SelfContainedScreen = z.infer<typeof selfContainedScreenSchema>;
export type Poster = z.infer<typeof posterSchema>;

export type GenerateInput = z.infer<typeof generateInputSchema>;
export type GenerateOutput = z.infer<typeof generateOutputSchema>;
