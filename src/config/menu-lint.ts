import { z } from "zod";

import { deepFreeze } from "../util/freeze";

/**
 * How the menu data-quality lint (D29) behaves. This is the INPUT-SIDE sanity layer the engine
 * previously lacked: the source menu can genuinely carry `$0.00`/missing prices, over-long names,
 * and duplicate dishes, and the engine renders input verbatim — so garbage in became garbage on a
 * customer-facing TV. Two orthogonal knobs, both rules-as-data:
 *
 * - `mode` governs what happens to the lint FINDINGS (reject the run / warn+surface / stay silent).
 * - `zeroPriceRender` governs the downstream RENDER of zero/missing prices, independently of `mode`.
 */
export const menuLintModeSchema = z.enum(["warn", "reject", "off"]);

/**
 * How the pipeline renders an item whose price is zero or missing:
 * - `"hide"` (default): the item ships with NO price element (never a literal `$0.00`). The
 *   zero/missing price is stripped from the item BEFORE it reaches the painter and QA, so the
 *   painter never emits a price span and the required-`price`-binding check exempts it (an item
 *   with no price data is already exempt) — paint and QA stay coherent instead of fighting.
 * - `"verbatim"`: the item renders exactly as authored (a `0` price becomes `$0.00`).
 */
export const zeroPriceRenderSchema = z.enum(["hide", "verbatim"]);

export const menuLintConfigSchema = z.object({
  /**
   * `"warn"` (default): findings are logged via the Logger port and surfaced on
   * `qaReport.menuLint`; generation proceeds. `"reject"`: a non-empty lint throws a
   * {@link ValidationError} listing the findings, before any planning/paint. `"off"`: the lint is
   * neither surfaced nor logged nor enforced (the `zeroPriceRender` transform still applies).
   */
  mode: menuLintModeSchema.default("warn"),
  /** Downstream render policy for zero/missing prices — see {@link zeroPriceRenderSchema}. */
  zeroPriceRender: zeroPriceRenderSchema.default("hide"),
  /** Item names longer than this (chars) emit `name-overlong` — they truncate/shrink on a board. */
  maxNameChars: z.number().int().positive().default(60),
  /** Item descriptions longer than this (chars) emit `description-overlong`. */
  maxDescriptionChars: z.number().int().positive().default(240),
});

export type MenuLintMode = z.infer<typeof menuLintModeSchema>;
export type ZeroPriceRender = z.infer<typeof zeroPriceRenderSchema>;
export type MenuLintConfig = z.infer<typeof menuLintConfigSchema>;

export const defaultMenuLintConfig = (): MenuLintConfig =>
  deepFreeze(menuLintConfigSchema.parse({}));
