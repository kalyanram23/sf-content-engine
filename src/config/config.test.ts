import { describe, expect, it } from "vitest";

import { ConfigError } from "../domain/errors";
import { modelRoleSchema } from "./models";
import { orientViewport, viewportForAspect } from "./qa";
import { defaultEngineConfig, loadEngineConfig } from "./index";

describe("loadEngineConfig", () => {
  it("produces the documented defaults", () => {
    const config = defaultEngineConfig();
    expect(config.loop.maxIterations).toBe(3);
    expect(config.qa.viewport).toEqual({ width: 1920, height: 1080, dpr: 1 });
    expect(config.qa.contrast.minNormal).toBe(4.5);
    expect(config.qa.requiredBindings).toEqual(["price"]);
    expect(config.routing.rules.map((r) => r.id)).toContain("mechanical-fix-to-repair");
    expect(config.rubric.dimensions.length).toBeGreaterThanOrEqual(5);
  });

  it("the balance + intentional-design rubric wording names dead space explicitly (D33)", () => {
    const dims = defaultEngineConfig().rubric.dimensions;
    const balance = dims.find((d) => d.id === "balance");
    const intentional = dims.find((d) => d.id === "intentional-design");
    expect(balance?.description).toMatch(/dead space/i);
    expect(intentional?.description).toMatch(/empty space/i);
  });

  it("carries an invented-copy rubric dimension (filler badges / fake brand names / leaked theme name)", () => {
    const dim = defaultEngineConfig().rubric.dimensions.find((d) => d.id === "invented-copy");
    expect(dim).toBeDefined();
    expect(dim?.failAtSeverity).toBe("major");
    expect(dim?.description).toMatch(/theme's internal name/i);
    expect(dim?.description).toMatch(/PRICE LIST/);
  });

  it("defaults skipVisionWhenBlocking on (a gate-blocked candidate skips the paid critique, D27)", () => {
    expect(defaultEngineConfig().qa.skipVisionWhenBlocking).toBe(true);
  });

  it("allows disabling skipVisionWhenBlocking (restores critic feedback on blocked iterations)", () => {
    const config = loadEngineConfig({ qa: { skipVisionWhenBlocking: false } });
    expect(config.qa.skipVisionWhenBlocking).toBe(false);
    // untouched sibling QA fields keep their defaults
    expect(config.qa.blockingSeverity).toBe("major");
  });

  it("deep-merges a partial over defaults (per-field defaults still apply)", () => {
    const config = loadEngineConfig({ qa: { overflowTolerancePx: 4 } });
    expect(config.qa.overflowTolerancePx).toBe(4);
    // untouched sibling fields keep their defaults
    expect(config.qa.viewport.width).toBe(1920);
    expect(config.qa.density.maxFill).toBe(0.9);
  });

  it("freezes the result so consumers cannot mutate shared config", () => {
    const config = defaultEngineConfig();
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.qa)).toBe(true);
    expect(Object.isFrozen(config.routing.rules)).toBe(true);
  });

  it("throws ConfigError when a structured-output role uses a non-allowlisted model", () => {
    try {
      loadEngineConfig({ models: { critique: "some/unknown-tiny-model" } });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).code).toBe("CONFIG");
      expect((error as ConfigError).message).toContain("critique=some/unknown-tiny-model");
    }
  });

  it("accepts a non-allowlisted model once it is added to the allowlist", () => {
    const config = loadEngineConfig({
      models: {
        critique: "some/new-model",
        structuredOutputAllowlist: [
          "some/new-model",
          // the other structured-output roles (plan, repair) must remain covered
          "z-ai/glm-5.2",
          "openai/gpt-5.4-nano",
        ],
      },
    });
    expect(config.models.critique).toBe("some/new-model");
  });

  it("rejects structurally invalid config with a ValidationError-coded failure", () => {
    expect(() => loadEngineConfig({ loop: { maxIterations: 0 } })).toThrow(/Invalid engine config/);
  });

  it("defaults reasoning per role (plan thinks, paint reasons at low effort) plus a request timeout", () => {
    const config = defaultEngineConfig();
    expect(config.models.reasoning.plan).toEqual({ enabled: true });
    // paint reasoning is ON at effort:"low": effort does NOT cap GLM's reasoning (~70% of paint
    // tokens) but reasoning-ON measurably improves contract compliance — hex/token-lint majors and
    // malformed boards appeared only with it OFF (A/B'd across full runs, 2026-07-05). The
    // runaway-token risk is contained downstream by D34/D42/D32. One line to change.
    expect(config.models.reasoning.paint).toEqual({ effort: "low" });
    expect(config.models.reasoning.critique).toBeUndefined();
    expect(config.models.requestTimeoutMs).toBe(300000);
  });

  it("defaults a longer per-attempt timeout for the fallback model than the primary", () => {
    const config = defaultEngineConfig();
    // The fallback (anthropic/claude-sonnet-4.6) is slower-but-steadier: a big-board paint is >300s of
    // healthy generation, so sharing the primary's 300s leash guillotined every big-board fallback
    // attempt. It earns a 15-min leash; the primary keeps its short one.
    expect(config.models.requestTimeoutMs).toBe(300000);
    expect(config.models.fallbackRequestTimeoutMs).toBe(900000);
    expect(config.models.fallbackRequestTimeoutMs).toBeGreaterThan(config.models.requestTimeoutMs);
  });

  it("overrides the fallback request timeout while keeping the primary default", () => {
    const config = loadEngineConfig({ models: { fallbackRequestTimeoutMs: 600000 } });
    expect(config.models.fallbackRequestTimeoutMs).toBe(600000);
    expect(config.models.requestTimeoutMs).toBe(300000);
  });

  it("overrides one role's reasoning while keeping sibling defaults", () => {
    const config = loadEngineConfig({ models: { reasoning: { paint: { maxTokens: 4000 } } } });
    expect(config.models.reasoning.paint).toEqual({ maxTokens: 4000 });
    // plan keeps its default even though only paint was overridden (per-field defaults)
    expect(config.models.reasoning.plan).toEqual({ enabled: true });
  });

  it("defaults per-role max_tokens caps (generous — reasoning tokens count inside them)", () => {
    expect(defaultEngineConfig().models.maxTokens).toEqual({
      plan: 8000,
      paint: 32000,
      critique: 8000,
      repair: 16000,
    });
  });

  it("overrides one role's maxTokens while keeping sibling defaults", () => {
    const config = loadEngineConfig({ models: { maxTokens: { paint: 20000 } } });
    expect(config.models.maxTokens.paint).toBe(20000);
    // plan keeps its default even though only paint was overridden (per-field defaults)
    expect(config.models.maxTokens.plan).toBe(8000);
  });

  it("has retired the unused adjudicate role (owner decision)", () => {
    const config = defaultEngineConfig();
    expect(config.models).not.toHaveProperty("adjudicate");
    expect(config.models.reasoning).not.toHaveProperty("adjudicate");
    // The role enum no longer accepts it.
    expect(modelRoleSchema.safeParse("adjudicate").success).toBe(false);
    expect(modelRoleSchema.options).toEqual(["plan", "paint", "critique", "repair"]);
  });

  it("defaults the per-role resilience attempt budget (paint gets the extra retry)", () => {
    const config = defaultEngineConfig();
    expect(config.models.resilience).toEqual({
      plan: { maxAttempts: 2 },
      paint: { maxAttempts: 3 },
      critique: { maxAttempts: 2 },
      repair: { maxAttempts: 2 },
    });
  });

  it("overrides one role's resilience budget while keeping sibling defaults", () => {
    const config = loadEngineConfig({ models: { resilience: { plan: { maxAttempts: 4 } } } });
    expect(config.models.resilience.plan.maxAttempts).toBe(4);
    // paint keeps its default even though only plan was overridden (per-field defaults)
    expect(config.models.resilience.paint.maxAttempts).toBe(3);
  });

  it("defaults a paint fallback model and no fallback for the other roles", () => {
    const config = defaultEngineConfig();
    expect(config.models.fallback.paint).toBe("anthropic/claude-sonnet-4.6");
    expect(config.models.fallback.plan).toBeUndefined();
    expect(config.models.fallback.critique).toBeUndefined();
    expect(config.models.fallback.repair).toBeUndefined();
  });

  it("keeps the paint fallback default when only another role's fallback is set", () => {
    const config = loadEngineConfig({ models: { fallback: { critique: "openai/gpt-5.4-mini" } } });
    expect(config.models.fallback.critique).toBe("openai/gpt-5.4-mini");
    // paint's field-level default survives a sibling override
    expect(config.models.fallback.paint).toBe("anthropic/claude-sonnet-4.6");
  });

  it("validates a structured-role fallback against the allowlist at load (D11)", () => {
    try {
      loadEngineConfig({ models: { fallback: { repair: "some/unknown-fallback" } } });
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as ConfigError).message).toContain("repair.fallback=some/unknown-fallback");
    }
  });

  it("accepts a structured-role fallback once it is on the allowlist", () => {
    const config = loadEngineConfig({ models: { fallback: { repair: "openai/gpt-5.4-mini" } } });
    expect(config.models.fallback.repair).toBe("openai/gpt-5.4-mini");
  });
});

/**
 * orientViewport (D19): aspect owns ORIENTATION, qa.viewport owns RESOLUTION + DPR. It swaps the
 * configured viewport's dimensions only when the requested aspect disagrees with the configured
 * orientation — so a 9:16 request renders portrait for EVERY caller, not just scripts/try.ts.
 */
describe("orientViewport", () => {
  it("leaves a landscape viewport untouched for a 16:9 request", () => {
    expect(orientViewport({ width: 1920, height: 1080, dpr: 1 }, "16:9")).toEqual({
      width: 1920,
      height: 1080,
      dpr: 1,
    });
  });

  it("swaps a landscape default to portrait for a 9:16 request", () => {
    expect(orientViewport({ width: 1920, height: 1080, dpr: 1 }, "9:16")).toEqual({
      width: 1080,
      height: 1920,
      dpr: 1,
    });
  });

  it("preserves a higher resolution + DPR while re-orienting (resolution stays the caller's)", () => {
    expect(orientViewport({ width: 3840, height: 2160, dpr: 2 }, "9:16")).toEqual({
      width: 2160,
      height: 3840,
      dpr: 2,
    });
  });

  it("leaves an already-portrait viewport untouched for a 9:16 request", () => {
    expect(orientViewport({ width: 1080, height: 1920, dpr: 1 }, "9:16")).toEqual({
      width: 1080,
      height: 1920,
      dpr: 1,
    });
  });

  it("never swaps a square viewport", () => {
    expect(orientViewport({ width: 1000, height: 1000, dpr: 1 }, "9:16")).toEqual({
      width: 1000,
      height: 1000,
      dpr: 1,
    });
  });

  it("agrees with viewportForAspect on the default resolution", () => {
    const fromDefault = orientViewport({ width: 1920, height: 1080, dpr: 1 }, "9:16");
    expect(fromDefault).toEqual(viewportForAspect("9:16"));
  });
});
