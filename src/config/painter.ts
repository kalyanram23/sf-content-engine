import { z } from "zod";

import { deepFreeze } from "../util/freeze";

/**
 * Painter-facing prompt config. `antiPatterns` is the board-set negative list — known LLM
 * design failure modes, phrased as VISUALLY checkable rules (never token-value assertions;
 * palette enforcement stays with the deterministic token-lint). Appended to every painter
 * prompt and shown to the vision critic, so generator and judge share one list. Editing the
 * list is a config change, never an engine change.
 */
export const painterConfigSchema = z.object({
  /**
   * How a board is painted (D71). `auto` (default) routes per-theme: a theme that names a
   * registered `vocabulary` paints via the deterministic composition path, everything else
   * free-paints. `free` always free-paints (ignores vocabularies). `composition` forces the
   * composition path for every board — which requires `ports.composer` plus a registered
   * vocabulary for the theme (a plain theme in this mode fails loud), so it's a CI/debug lever.
   */
  mode: z.enum(["auto", "free", "composition"]).default("auto"),
  antiPatterns: z
    .array(z.string().min(1))
    .default([
      "Gradient-filled or background-clip text effects — headline text is a solid token colour",
      "Panels or text in default pure #000/#fff that visibly ignore the theme's palette — a theme's own near-white or near-black token values ARE the palette, not a violation",
      "Two rival hero blocks of equal visual weight — one clear focal point per board",
      "A 'hero' photo reduced to a small corner thumbnail — heroes are prominent or omitted",
      "Filler badge chips that carry no menu information (PRICE LIST, USD, ALL DAY, FRESH · HOT · DAILY, MADE TO ORDER)",
      "An invented restaurant name, tagline, or fake establishment branding when no brand was provided",
      "Abstract decorative placeholder graphics (crop marks, crosshairs, doodle boxes) filling a spare panel — spare space goes to menu content or bigger type, never placeholder art",
    ]),
});

export type PainterConfig = z.infer<typeof painterConfigSchema>;

export const defaultPainterConfig = (): PainterConfig => deepFreeze(painterConfigSchema.parse({}));
