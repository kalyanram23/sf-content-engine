import { z } from "zod";

import { deepFreeze } from "../util/freeze";

/** The LLM roles the engine routes (spec §9). */
export const modelRoleSchema = z.enum(["plan", "paint", "critique", "repair", "adjudicate"]);
export type ModelRole = z.infer<typeof modelRoleSchema>;

/**
 * Per-role reasoning control, mapped to OpenRouter's `reasoning` request field by the adapter
 * (`src/adapters/openrouter/client.ts`). Every field is optional so a role tunes only what it needs.
 */
export const reasoningSettingSchema = z.object({
  /** Force reasoning on/off; when unset the model's own default applies. */
  enabled: z.boolean().optional(),
  /**
   * OpenAI-style effort bucket — the lever models WITHOUT a hard reasoning budget actually honour
   * (e.g. z-ai/GLM): OpenRouter maps `maxTokens` to an effort level for them, so prefer `effort`
   * directly there.
   */
  effort: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(),
  /**
   * Anthropic-style hard reasoning-token budget. A real cap only on Gemini / Anthropic /
   * Qwen-thinking models; elsewhere OpenRouter normalises it to an `effort` level.
   */
  maxTokens: z.number().int().positive().optional(),
  /** Drop reasoning tokens from the response body (the reasoning still happens). */
  exclude: z.boolean().optional(),
});

export type ReasoningSetting = z.infer<typeof reasoningSettingSchema>;

/**
 * OpenRouter model routing (D1). Each role maps to a model id; swapping a model is a data
 * edit. The §9 caution is encoded as defaults, picked for highest-quality-per-dollar:
 * `paint` is a strong, cost-efficient HTML/coding model (GLM-5.2 — taste/layout at a fraction
 * of a frontier model's cost; it returns free HTML so it needs no structured-output support),
 * `critique` MUST stay a vision + structured-output model (it judges a screenshot under a
 * strict JSON schema — no GLM vision variant supports strict structured outputs), and
 * `repair` is a cheap structured model. `plan` rarely runs (v1 uses a hand-authored plan) so
 * it shares the cheap structured `paint` model. `structuredOutputAllowlist` is checked at
 * config load so a model that can't do strict JSON for the plan/critique/repair roles fails
 * loudly (D11) — `paint`/`adjudicate` are exempt (paint is free text; adjudicate is unused).
 */
export const modelRoutingSchema = z.object({
  plan: z.string().min(1).default("z-ai/glm-5.2"),
  paint: z.string().min(1).default("z-ai/glm-5.2"),
  critique: z.string().min(1).default("openai/gpt-5.4-mini"),
  repair: z.string().min(1).default("openai/gpt-5.4-nano"),
  adjudicate: z.string().min(1).default("anthropic/claude-opus-4.8"),
  structuredOutputAllowlist: z
    .array(z.string().min(1))
    .default([
      "z-ai/glm-5.2",
      "anthropic/claude-sonnet-4.6",
      "anthropic/claude-opus-4.8",
      "openai/gpt-5.5",
      "openai/gpt-5.4",
      "openai/gpt-5.4-mini",
      "openai/gpt-5.4-nano",
      "google/gemini-3.5-flash",
      "google/gemini-3.1-pro-preview",
    ]),
  /**
   * Per-role reasoning control. Defaults: `plan` thinks (judgment-heavy, one cheap call); `paint`
   * is bounded to LOW effort (long-form HTML where unbounded reasoning starves the content budget
   * and can return an empty body — the screen-3 failure). `critique`/`repair`/`adjudicate` keep the
   * model default. Override per role, e.g. `paint: { maxTokens: 4000 }`.
   */
  reasoning: z
    .object({
      plan: reasoningSettingSchema.prefault({ enabled: true }),
      paint: reasoningSettingSchema.prefault({ effort: "low" }),
      critique: reasoningSettingSchema.optional(),
      repair: reasoningSettingSchema.optional(),
      adjudicate: reasoningSettingSchema.optional(),
    })
    .prefault({}),
  /**
   * Per-request timeout (ms) for every OpenRouter call, set on the SDK client so a stalled call
   * (e.g. a dead socket) can't hang the run for minutes — the SDK default is 10 min. With `paint`
   * reasoning bounded above, paints finish well inside this.
   */
  requestTimeoutMs: z.number().int().positive().default(300000),
});

export type ModelRouting = z.infer<typeof modelRoutingSchema>;

export const defaultModelRouting = (): ModelRouting => deepFreeze(modelRoutingSchema.parse({}));
