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
