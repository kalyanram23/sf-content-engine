import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BrandAssetError } from "../../domain/errors";
import { normalizeBrandLogo, resolveAssetToDataUri } from "./asset-resolver";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("resolveAssetToDataUri", () => {
  it("passes a data: URI through unchanged", async () => {
    const uri = "data:image/png;base64,AAAA";
    expect(await resolveAssetToDataUri(uri)).toBe(uri);
  });

  it("reads a local file into a data-URI", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brand-"));
    const file = join(dir, "logo.png");
    writeFileSync(file, PNG_BYTES);
    const uri = await resolveAssetToDataUri(file);
    expect(uri.startsWith("data:image/png;base64,")).toBe(true);
    expect(uri).toBe(`data:image/png;base64,${PNG_BYTES.toString("base64")}`);
  });

  it("throws BrandAssetError for a missing file", async () => {
    await expect(resolveAssetToDataUri("/no/such/logo.png")).rejects.toBeInstanceOf(
      BrandAssetError,
    );
  });

  it("throws BrandAssetError for a malformed file:// URL", async () => {
    await expect(resolveAssetToDataUri("file://%zz")).rejects.toBeInstanceOf(BrandAssetError);
  });
});

describe("normalizeBrandLogo", () => {
  it("leaves input without a brand logo untouched", async () => {
    const input = { items: [], brief: { presetId: "x" } };
    expect(await normalizeBrandLogo(input)).toBe(input);
  });

  it("resolves brand.logo.src to a data-URI, preserving siblings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brand-"));
    const file = join(dir, "logo.png");
    writeFileSync(file, PNG_BYTES);
    const out = (await normalizeBrandLogo({
      items: [],
      brief: { presetId: "x" },
      brand: { logo: { src: file, alt: "Acme" }, name: "Acme" },
    })) as { brand: { logo: { src: string; alt: string }; name: string } };
    expect(out.brand.logo.src.startsWith("data:image/png;base64,")).toBe(true);
    expect(out.brand.logo.alt).toBe("Acme");
    expect(out.brand.name).toBe("Acme");
  });

  it("leaves an already-data-URI logo unchanged", async () => {
    const input = { brand: { logo: { src: "data:image/png;base64,AAAA" } } };
    const out = (await normalizeBrandLogo(input)) as typeof input;
    expect(out.brand.logo.src).toBe("data:image/png;base64,AAAA");
  });
});
