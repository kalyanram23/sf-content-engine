import { describe, expect, it } from "vitest";
import { z } from "zod";

import { createOpenRouterClient, requestStructured } from "./client";

/**
 * Live OpenRouter test. Run with `OPENROUTER_API_KEY=... npm run test:live`. Asserts
 * schema-validity and the structured-output path (not exact bytes — LLMs are best-effort, D15).
 * Skips when no key is present.
 */
const KEY = process.env["OPENROUTER_API_KEY"];

describe.skipIf(!KEY)("OpenRouter structured output (live)", () => {
  it("returns schema-valid JSON through the hardened path", async () => {
    const client = createOpenRouterClient({ apiKey: KEY as string });
    const schema = z.object({ city: z.string() });
    const result = await requestStructured(client, {
      model: "openai/gpt-5.4-nano",
      schema,
      schemaName: "city",
      system: "You answer with structured JSON only.",
      user: "What is the capital of France? Put it in the `city` field.",
    });
    expect(typeof result.city).toBe("string");
    expect(result.city.length).toBeGreaterThan(0);
  });
});
