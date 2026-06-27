import { z } from "zod";

import { deepFreeze } from "../util/freeze";

/** The LLM roles the engine routes (spec §9). */
export const modelRoleSchema = z.enum(["plan", "paint", "critique", "repair", "adjudicate"]);
export type ModelRole = z.infer<typeof modelRoleSchema>;

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
});

export type ModelRouting = z.infer<typeof modelRoutingSchema>;

export const defaultModelRouting = (): ModelRouting => deepFreeze(modelRoutingSchema.parse({}));
