import { describe, expect, it } from "vitest";

import { ConfigError } from "../domain/errors";
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

  it("defaults reasoning per role (plan thinks, paint is bounded) plus a request timeout", () => {
    const config = defaultEngineConfig();
    expect(config.models.reasoning.plan).toEqual({ enabled: true });
    expect(config.models.reasoning.paint).toEqual({ effort: "low" });
    expect(config.models.reasoning.critique).toBeUndefined();
    expect(config.models.requestTimeoutMs).toBe(300000);
  });

  it("overrides one role's reasoning while keeping sibling defaults", () => {
    const config = loadEngineConfig({ models: { reasoning: { paint: { maxTokens: 4000 } } } });
    expect(config.models.reasoning.paint).toEqual({ maxTokens: 4000 });
    // plan keeps its default even though only paint was overridden (per-field defaults)
    expect(config.models.reasoning.plan).toEqual({ enabled: true });
  });
});
