import { parseOrThrow } from "../domain/parse";
import { resolvedThemeSchema } from "../domain/schemas";
import type { ResolvedTheme, ThemeBrief, ThemePreset } from "../domain/types";

/**
 * Resolve a preset against a brief (spec §5.3): start from the vetted preset and perturb
 * it — override palette tokens, set the density posture, carry the motif. Pure; the result
 * is what the painter paints against and what the rails (token-lint, motion-vocab) enforce.
 * A brief override mostly changes which token values the paint sees (spec §5.3).
 */
export function resolveTheme(preset: ThemePreset, brief: ThemeBrief): ResolvedTheme {
  const resolved: ResolvedTheme = {
    ...preset,
    tokens: {
      ...preset.tokens,
      colors: { ...preset.tokens.colors, ...(brief.palette ?? {}) },
    },
    density: brief.density ?? "balanced",
    ...(brief.motif !== undefined ? { motif: brief.motif } : {}),
  };
  // Validate at the boundary so a malformed preset/brief fails loudly.
  return parseOrThrow(resolvedThemeSchema, resolved, "resolved theme");
}
