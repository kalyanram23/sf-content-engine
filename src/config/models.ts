import { z } from "zod";

import { deepFreeze } from "../util/freeze";

/** The LLM roles the engine routes (spec §9; `compose` fills the composition order form, D71). */
export const modelRoleSchema = z.enum(["plan", "paint", "critique", "repair", "compose"]);
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
  // The composer fills the strict composition order form (D71). Defaults to Sonnet: the prototype
  // measured clean, low-latency (4–9s) structured compositions on it, and it is allowlist-checked
  // below (a composer that can't do strict JSON would silently ship malformed compositions).
  compose: z.string().min(1).default("anthropic/claude-sonnet-5"),
  structuredOutputAllowlist: z
    .array(z.string().min(1))
    .default([
      "z-ai/glm-5.2",
      "anthropic/claude-sonnet-5",
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
   * reasons at `effort:"low"`. The full story (A/B'd across full eval runs, 2026-07-05): `effort`
   * does NOT actually cap GLM-5.2's reasoning — even at `"low"` it spends ~70% of its paint
   * completion tokens thinking — so `effort` is NOT a token-economy lever here. But reasoning being
   * ON is a QUALITY lever: turning it OFF (the earlier D42 setting) made the paint model start
   * violating basic contract rules it otherwise honours — raw-hex inline styles (token-lint majors)
   * and duplicated / cut-off headers appeared ONLY with reasoning off, dropping the judge ship-rate.
   * The original reasons to disable it — runaway reasoning burning the 32000-token cap into
   * empty-board retries/fallbacks, ~19-minute calls, retry spend — are now independently contained
   * downstream WITHOUT sacrificing quality: truncation-retry (D34), the enforced per-attempt
   * `requestTimeoutMs` (D42 Fix 2), and the Sonnet `paint` fallback (D32). The residual cost is
   * ~$2.60/run, trivial next to the regression. `critique`/`repair` keep the model default. One line
   * to change if a run regresses. Override per role, e.g. `paint: { maxTokens: 4000 }`.
   */
  reasoning: z
    .object({
      plan: reasoningSettingSchema.prefault({ enabled: true }),
      paint: reasoningSettingSchema.prefault({ effort: "low" }),
      critique: reasoningSettingSchema.optional(),
      repair: reasoningSettingSchema.optional(),
      // Composition is a small judgment call, not a reasoning-heavy one: the prototype measured 4–9s
      // clean structured outputs with reasoning OFF, so default it off (override per run if quality dips).
      compose: reasoningSettingSchema.prefault({ enabled: false }),
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
      // A composer fallback is also allowlist-checked (D11): if set, it must honour strict JSON.
      compose: z.string().min(1).optional(),
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
  /**
   * Per-request timeout (ms) for a FALLBACK model's attempts — a longer leash than the primary's
   * `requestTimeoutMs` (default 300s). The fallback is the last line before a crashed board, and it's
   * a slower-but-STEADIER model (default `anthropic/claude-sonnet-4.6`) that needs real generation
   * time: painting a 40+ item board is >300s of pure, healthy generation for it. Sharing the primary's
   * 300s leash guillotined it on every big-board attempt — tonight's traces: 29 fallback calls, 22
   * killed at EXACTLY the shared 300.00s, 3 boards crashed "timed out on every attempt" (the rescue
   * model could structurally never rescue). The primary (`z-ai/glm-5.2`) is fast when healthy (20–40s)
   * and stalls otherwise, so 300s is the right leash for IT; the fallback earns a separate, larger one.
   * Worst-case wall-clock is bounded by `resilience[role].maxAttempts × this value`, and the D28
   * per-board bulkheads contain that so one slow board can't stall the run.
   */
  fallbackRequestTimeoutMs: z.number().int().positive().default(900000),
});

export type ModelRouting = z.infer<typeof modelRoutingSchema>;

export const defaultModelRouting = (): ModelRouting => deepFreeze(modelRoutingSchema.parse({}));
