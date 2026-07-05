import { z } from "zod";

import { deepFreeze } from "../util/freeze";

/** The LLM roles the engine routes (spec §9). */
export const modelRoleSchema = z.enum(["plan", "paint", "critique", "repair"]);
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
 * Per-role RESILIENCE policy interpreted by the OpenRouter adapter (`client.ts`). `maxAttempts`
 * caps how many times a role's call is made against its PRIMARY model before the adapter either
 * falls back (if a `fallback` model is configured, below) or gives up. An attempt is retried when
 * the response is EMPTY (a free-text paint that produced no content — a thinking model can burn its
 * whole budget on reasoning) or fails the structured-output contract (invalid JSON / schema
 * mismatch); a transient network drop is also retried within the budget. This makes a single bad
 * completion a retry, not a fatal abort of the whole `generate()` run.
 */
export const resiliencePolicySchema = z.object({
  maxAttempts: z.number().int().min(1).default(2),
});

export type ResiliencePolicy = z.infer<typeof resiliencePolicySchema>;

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
 * loudly (D11) — `paint` is exempt (it returns free text). Each role may declare an optional
 * `fallback` model (below), tried after the primary exhausts its `resilience` attempt budget.
 */
export const modelRoutingSchema = z.object({
  plan: z.string().min(1).default("z-ai/glm-5.2"),
  paint: z.string().min(1).default("z-ai/glm-5.2"),
  critique: z.string().min(1).default("openai/gpt-5.4-mini"),
  repair: z.string().min(1).default("openai/gpt-5.4-nano"),
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
   * and can return an empty body — the screen-3 failure). `critique`/`repair` keep the model
   * default. Override per role, e.g. `paint: { maxTokens: 4000 }`.
   */
  reasoning: z
    .object({
      plan: reasoningSettingSchema.prefault({ enabled: true }),
      paint: reasoningSettingSchema.prefault({ effort: "low" }),
      critique: reasoningSettingSchema.optional(),
      repair: reasoningSettingSchema.optional(),
    })
    .prefault({}),
  /**
   * Per-role `max_tokens` cap, mapped to OpenRouter's `max_tokens` request field by the adapters.
   * OpenRouter reserves `max_tokens` as credit COLLATERAL, so an unbounded call (the structured roles
   * sent none) over-reserves and a reasoning-enabled plan is unbounded. Caps are generous because
   * reasoning tokens count INSIDE `max_tokens` on OpenRouter: `paint`/`repair` return full HTML so
   * they get the larger cap; `plan`/`critique` emit compact JSON but still think, hence 8000.
   * Paint MUST stay ≥32000: measured traces show glm-5.2 paint completions run 15k–24k tokens
   * TOTAL (reasoning alone burns 6.7k–15.2k before any HTML; the HTML itself is ~8-9k). A 16000
   * cap truncated the completion mid-HTML and surfaced as "painter returned empty HTML" — the
   * top crash class in the 2026-07-04 eval baseline (4/15 boards).
   */
  maxTokens: z
    .object({
      plan: z.number().int().positive().default(8000),
      paint: z.number().int().positive().default(32000),
      critique: z.number().int().positive().default(8000),
      repair: z.number().int().positive().default(16000),
    })
    .prefault({}),
  /**
   * Per-role attempt budget (config-as-data). Retried on an EMPTY body / structured-contract
   * failure / transient network drop before falling back or aborting. `paint` gets 3 (long, dense
   * HTML is the likeliest to come back empty); the structured roles get the schema-level default of
   * 2 (one initial + one corrective re-ask). Raising a role's `maxAttempts` trades cost for
   * reliability. Combined with `requestTimeoutMs`, worst-case wall-clock is attempts × timeout —
   * each attempt still respects the per-call cap.
   */
  resilience: z
    .object({
      plan: resiliencePolicySchema.prefault({ maxAttempts: 2 }),
      paint: resiliencePolicySchema.prefault({ maxAttempts: 3 }),
      critique: resiliencePolicySchema.prefault({ maxAttempts: 2 }),
      repair: resiliencePolicySchema.prefault({ maxAttempts: 2 }),
    })
    .prefault({}),
  /**
   * Optional per-role FALLBACK model id, tried once the primary exhausts its `resilience` attempt
   * budget (a persistently empty / non-conforming primary shouldn't sink the whole run). Fallbacks
   * for the structured roles (`plan`/`critique`/`repair`) are validated against
   * `structuredOutputAllowlist` at config load, exactly like the primaries (D11). Default: `paint`
   * falls back to the richer `anthropic/claude-sonnet-4.6` when GLM comes back empty; other roles
   * declare no fallback (add one per role as needed).
   */
  fallback: z
    .object({
      plan: z.string().min(1).optional(),
      // Field-level default so overriding another role's fallback keeps paint's (mirrors `reasoning`).
      paint: z.string().min(1).prefault("anthropic/claude-sonnet-4.6"),
      critique: z.string().min(1).optional(),
      repair: z.string().min(1).optional(),
    })
    .prefault({}),
  /**
   * Per-request timeout (ms) for every OpenRouter call, set on the SDK client so a stalled call
   * (e.g. a dead socket) can't hang the run for minutes — the SDK default is 10 min. The client is
   * ALSO constructed with `maxRetries: 0` (client.ts) so the SDK's own auto-retry can't silently
   * stack additional timeout windows on top of this cap; the config-driven `resilience` loop is the
   * single retry authority. With `paint` reasoning bounded above, paints finish well inside this.
   */
  requestTimeoutMs: z.number().int().positive().default(300000),
});

export type ModelRouting = z.infer<typeof modelRoutingSchema>;

export const defaultModelRouting = (): ModelRouting => deepFreeze(modelRoutingSchema.parse({}));
