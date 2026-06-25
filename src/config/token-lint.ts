import { z } from "zod";

import { deepFreeze } from "../util/freeze";

/**
 * Token-lint rules (spec §5.2 rail). The linter runs on the LLM-authored markup BEFORE
 * Tailwind compilation (D3/S7): it rejects raw hex/px in class arbitrary-value utilities
 * (`text-[#fff]`, `p-[7px]`), inline `style` attributes, and `<style>` block content, so
 * paint stays on the token scale instead of inventing values.
 */
export const tokenLintRulesSchema = z.object({
  allowRawHex: z.boolean().default(false),
  allowRawPx: z.boolean().default(false),
  /** px values tolerated even when `allowRawPx` is false (hairlines, resets). */
  allowedPxValues: z.array(z.number()).default([0, 1]),
});

export type TokenLintRules = z.infer<typeof tokenLintRulesSchema>;

export const defaultTokenLintRules = (): TokenLintRules =>
  deepFreeze(tokenLintRulesSchema.parse({}));
