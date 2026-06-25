import { z } from "zod";

import { deepFreeze } from "../util/freeze";

/** The LLM roles the engine routes (spec §9). */
export const modelRoleSchema = z.enum(["plan", "paint", "critique", "repair", "adjudicate"]);
export type ModelRole = z.infer<typeof modelRoleSchema>;

/**
 * OpenRouter model routing (D1). Each role maps to a model id; swapping a model is a data
 * edit. The §9 caution is encoded as defaults: `paint` is a frontier model (taste/layout
 * coherence), while `critique`/`repair` are cheap models that still honour structured
 * outputs. `structuredOutputAllowlist` is checked at config load so a model that can't do
 * strict JSON for the plan/critique/repair roles fails loudly (D11).
 */
export const modelRoutingSchema = z.object({
  plan: z.string().min(1).default("anthropic/claude-sonnet-4.5"),
  paint: z.string().min(1).default("anthropic/claude-sonnet-4.5"),
  critique: z.string().min(1).default("openai/gpt-4o-mini"),
  repair: z.string().min(1).default("openai/gpt-4o-mini"),
  adjudicate: z.string().min(1).default("anthropic/claude-opus-4.1"),
  structuredOutputAllowlist: z
    .array(z.string().min(1))
    .default([
      "anthropic/claude-sonnet-4.5",
      "anthropic/claude-opus-4.1",
      "openai/gpt-4o",
      "openai/gpt-4o-mini",
      "openai/gpt-4.1",
      "openai/gpt-4.1-mini",
      "google/gemini-2.5-flash",
      "google/gemini-2.5-pro",
    ]),
});

export type ModelRouting = z.infer<typeof modelRoutingSchema>;

export const defaultModelRouting = (): ModelRouting => deepFreeze(modelRoutingSchema.parse({}));
