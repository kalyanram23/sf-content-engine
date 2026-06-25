import type { ThemeRepository } from "../../ports/theme-repository";
import type { ThemePreset } from "../../domain/types";
import { botanicalPreset } from "./botanical";

export { botanicalPreset } from "./botanical";

/** A simple in-memory {@link ThemeRepository} over a fixed set of presets. */
export class InMemoryThemeRepository implements ThemeRepository {
  private readonly byId: Map<string, ThemePreset>;

  constructor(presets: readonly ThemePreset[] = [botanicalPreset]) {
    this.byId = new Map(presets.map((p) => [p.id, p]));
  }

  get(presetId: string): Promise<ThemePreset | undefined> {
    return Promise.resolve(this.byId.get(presetId));
  }
}

/** The default repository, registering the bundled presets (botanical for v1). */
export function createDefaultThemeRepository(): ThemeRepository {
  return new InMemoryThemeRepository([botanicalPreset]);
}
