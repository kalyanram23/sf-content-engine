import type { ThemePreset } from "../domain/types";

/**
 * Resolves a preset id to its vetted bundle (tokens + motion vocabulary + assets, §5.3).
 * Returns `undefined` for an unknown id; the resolveTheme node raises a structured
 * `ThemeNotFoundError`. A future per-preset image-background cache is a seam here (§8).
 */
export interface ThemeRepository {
  get(presetId: string): Promise<ThemePreset | undefined>;
}
