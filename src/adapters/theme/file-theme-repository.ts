import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { parseOrThrow } from "../../domain/parse";
import { themePresetSchema } from "../../domain/schemas";
import type { ThemePreset } from "../../domain/types";
import type { ThemeRepository } from "../../ports/theme-repository";

/**
 * A Node {@link ThemeRepository} that loads EXTERNALIZED theme files (`<id>.theme.json`) from a
 * directory at runtime — so authoring a theme is dropping one file, no recompile (S9 adapter; fs
 * is allowed here, the pure core only sees the port). Each file is validated against
 * `themePresetSchema`. A missing directory yields an empty repo, so it composes safely with a
 * bundled default via {@link createFileThemeRepository}.
 */
export class FileThemeRepository implements ThemeRepository {
  private readonly byId = new Map<string, ThemePreset>();

  constructor(dir: string) {
    let files: string[] = [];
    try {
      files = readdirSync(dir).filter((f) => f.endsWith(".theme.json"));
    } catch {
      files = [];
    }
    for (const file of files) {
      const raw: unknown = JSON.parse(readFileSync(resolve(dir, file), "utf8"));
      const preset = parseOrThrow(themePresetSchema, raw, `theme file "${file}"`);
      this.byId.set(preset.id, preset);
    }
  }

  get(presetId: string): Promise<ThemePreset | undefined> {
    return Promise.resolve(this.byId.get(presetId));
  }

  /** The theme ids loaded from disk (for diagnostics/logging). */
  ids(): string[] {
    return [...this.byId.keys()];
  }
}

/**
 * Load themes from `dir`, deferring to `fallback` for any id not found on disk. Lets a venue
 * drop custom theme files while the engine's bundled presets remain available.
 */
export function createFileThemeRepository(
  dir: string,
  fallback?: ThemeRepository,
): FileThemeRepository | ThemeRepository {
  const fileRepo = new FileThemeRepository(dir);
  if (!fallback) return fileRepo;
  return {
    async get(presetId: string): Promise<ThemePreset | undefined> {
      return (await fileRepo.get(presetId)) ?? (await fallback.get(presetId));
    },
  };
}
