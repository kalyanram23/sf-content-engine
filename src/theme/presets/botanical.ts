import { parseOrThrow } from "../../domain/parse";
import { themePresetSchema } from "../../domain/schemas";
import type { ThemePreset } from "../../domain/types";
import botanicalThemeJson from "../../../themes/botanical.theme.json";

/**
 * The botanical preset (spec §7 v1) — now EXTERNALIZED to a single, editable theme file
 * (`themes/botanical.theme.json`) holding the base prompt, colour/typography tokens, motion
 * vocabulary, and assets. This module just imports + validates it (the JSON is bundled into
 * `dist`, so the pure core stays offline/fs-free). To author another theme, drop a sibling
 * `<id>.theme.json`; the Node `FileThemeRepository` (src/adapters/theme) loads them at runtime.
 */
export const botanicalPreset: ThemePreset = parseOrThrow(
  themePresetSchema,
  botanicalThemeJson,
  "botanical theme file",
);
