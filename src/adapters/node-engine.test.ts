import { describe, expect, it } from "vitest";

import { BrandAssetError } from "../domain/errors";
import { createNodeEngine } from "./node-engine";

/**
 * Hermetic: no network is reached because brand-logo resolution runs BEFORE the pure engine, and
 * a bogus logo path throws first. Proves createNodeEngine wraps generate with normalizeBrandLogo.
 */
describe("createNodeEngine — brand logo resolution", () => {
  it("resolves the brand logo before the pipeline, failing loud on a bad path", async () => {
    const engine = createNodeEngine({ openRouterApiKey: "test-key" });
    await expect(
      engine.generate({
        items: [{ id: "p1", name: "Pizza", category: "Mains", price: 9 }],
        brief: { presetId: "botanical" },
        brand: { logo: { src: "/no/such/logo.png" } },
      }),
    ).rejects.toBeInstanceOf(BrandAssetError);
  });
});

/**
 * Hermetic: construction only. Playwright/OpenRouter are lazy (no browser launched, no network at
 * construction), so wiring the composition path — OpenRouterComposer + builtin vocabularies +
 * CompositionPainter wrapped by an AutoPainter — is exercised without a key or a browser. Every
 * paint mode must assemble; an unknown mode must fail loud at config load (the enum is the contract).
 */
describe("createNodeEngine — composition painter wiring", () => {
  it("constructs with the default (auto) paint mode", () => {
    const engine = createNodeEngine({ openRouterApiKey: "test-key" });
    expect(typeof engine.generate).toBe("function");
    expect(typeof engine.plan).toBe("function");
  });

  it("constructs with paint mode 'free'", () => {
    expect(() =>
      createNodeEngine({
        openRouterApiKey: "test-key",
        config: { painter: { mode: "free" } },
      }),
    ).not.toThrow();
  });

  it("constructs with paint mode 'composition'", () => {
    expect(() =>
      createNodeEngine({
        openRouterApiKey: "test-key",
        config: { painter: { mode: "composition" } },
      }),
    ).not.toThrow();
  });

  it("rejects an unknown paint mode at config load", () => {
    expect(() =>
      createNodeEngine({
        openRouterApiKey: "test-key",
        config: { painter: { mode: "nope" } },
      }),
    ).toThrow();
  });
});
