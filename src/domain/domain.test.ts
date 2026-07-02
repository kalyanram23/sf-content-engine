import { describe, expect, it } from "vitest";

import { BrandAssetError, ContentEngineError, ValidationError } from "./errors";
import { parseOrThrow } from "./parse";
import {
  brandInputSchema,
  canonicalItemSchema,
  generateInputSchema,
  themePresetSchema,
} from "./schemas";

describe("canonicalItemSchema", () => {
  it("defaults `available` to true", () => {
    const item = canonicalItemSchema.parse({ id: "p1", name: "Margherita" });
    expect(item.available).toBe(true);
  });

  it("accepts a size/price matrix and variants", () => {
    const item = canonicalItemSchema.parse({
      id: "p1",
      name: "Margherita",
      sizes: [
        { label: '8"', price: 8.99 },
        { label: '10"', price: 11.99 },
      ],
      variants: [{ label: "Veg" }, { label: "Paneer", price: 2 }],
    });
    expect(item.sizes).toHaveLength(2);
    expect(item.variants?.[1]?.price).toBe(2);
  });
});

describe("generateInputSchema", () => {
  it("applies constraint defaults", () => {
    const input = generateInputSchema.parse({
      items: [{ id: "p1", name: "Margherita" }],
      brief: { presetId: "botanical" },
    });
    expect(input.constraints).toEqual({
      aspect: "16:9",
      screens: 1,
      locale: "en-US",
      currency: "USD",
    });
  });

  it("rejects an empty item list", () => {
    const result = generateInputSchema.safeParse({ items: [], brief: { presetId: "botanical" } });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed hand-authored plan with an actionable error path", () => {
    try {
      parseOrThrow(
        generateInputSchema,
        {
          items: [{ id: "p1", name: "Margherita" }],
          brief: { presetId: "botanical" },
          // A section with no items violates planSectionSchema (items.min(1)).
          plan: {
            screens: [{ id: "s1", sections: [{ title: "T", representation: "list", items: [] }] }],
          },
        },
        "generate input",
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      // Path points at the offending nested location so the author can fix it.
      expect((error as ValidationError).message).toContain("plan.screens.0.sections.0.items");
    }
  });
});

describe("themePresetSchema component binds", () => {
  const base = {
    id: "t",
    name: "T",
    tokens: {
      colors: { bg: "#000", surface: "#111", text: "#fff", price: "#fc0" },
      fontFamilies: { body: "Inter" },
      radius: { md: "1rem", full: "9999px" },
    },
    motion: [{ name: "fade-in", kind: "css" as const }],
  };

  it("accepts component binds that resolve to declared tokens", () => {
    const preset = themePresetSchema.parse({
      ...base,
      components: [
        {
          id: "price-pill",
          role: "price pill",
          binds: { text: "price", bg: "surface" },
          rule: "one per item",
        },
      ],
    });
    expect(preset.components).toHaveLength(1);
  });

  it("rejects a component bind naming an undeclared token, with an actionable path", () => {
    try {
      parseOrThrow(
        themePresetSchema,
        {
          ...base,
          components: [
            { id: "price-pill", role: "price pill", binds: { bg: "nonexistent" }, rule: "x" },
          ],
        },
        "theme preset",
      );
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect((error as ValidationError).message).toContain("components.0.binds.bg");
      expect((error as ValidationError).message).toContain("not a declared token");
    }
  });
});

describe("parseOrThrow", () => {
  it("returns parsed data on success", () => {
    expect(parseOrThrow(canonicalItemSchema, { id: "x", name: "y" }, "item").id).toBe("x");
  });

  it("throws a structured ValidationError with a readable message and issues", () => {
    try {
      parseOrThrow(canonicalItemSchema, { id: "" }, "item");
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(ValidationError);
      expect(error).toBeInstanceOf(ContentEngineError);
      const err = error as ValidationError;
      expect(err.code).toBe("VALIDATION");
      expect(err.message).toContain("item");
      expect(Array.isArray(err.details?.["issues"])).toBe(true);
    }
  });
});

describe("brand input", () => {
  const base = {
    items: [{ id: "p1", name: "Pizza", category: "Mains", price: 9 }],
    brief: { presetId: "botanical" },
  };

  it("accepts a logo with name and tagline", () => {
    const parsed = generateInputSchema.parse({
      ...base,
      brand: {
        logo: { src: "data:image/png;base64,AAAA", alt: "Acme" },
        name: "Acme",
        tagline: "Fresh",
      },
    });
    expect(parsed.brand?.name).toBe("Acme");
    expect(parsed.brand?.logo?.src).toBe("data:image/png;base64,AAAA");
  });

  it("accepts input with no brand (backward compatible)", () => {
    expect(generateInputSchema.parse(base).brand).toBeUndefined();
  });

  it("rejects an empty logo src", () => {
    expect(() => brandInputSchema.parse({ logo: { src: "" } })).toThrow();
  });

  it("BrandAssetError carries the stable code", () => {
    const err = new BrandAssetError("nope");
    expect(err.code).toBe("BRAND_ASSET");
    expect(err).toBeInstanceOf(BrandAssetError);
  });
});
