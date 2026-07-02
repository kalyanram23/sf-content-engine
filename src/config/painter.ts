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
  antiPatterns: z
    .array(z.string().min(1))
    .default([
      "Gradient-filled or background-clip text effects — headline text is a solid token colour",
      "Panels or text in default pure #000/#fff that visibly ignore the theme's palette — a theme's own near-white or near-black token values ARE the palette, not a violation",
      "Two rival hero blocks of equal visual weight — one clear focal point per board",
      "A 'hero' photo reduced to a small corner thumbnail — heroes are prominent or omitted",
    ]),
});

export type PainterConfig = z.infer<typeof painterConfigSchema>;

export const defaultPainterConfig = (): PainterConfig => deepFreeze(painterConfigSchema.parse({}));
