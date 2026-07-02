import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { BrandAssetError } from "../../domain/errors";
import { mimeFor, mimeForPath } from "./mime";

/**
 * Resolve a brand asset `src` to an offline-safe `data:` URI so the pure core never sees a
 * network/fs reference (hermetic boundary). Handles three source kinds:
 *   - `data:`            → returned unchanged
 *   - `http(s)://`       → fetched, MIME-detected, base64-encoded
 *   - `file://` or path  → read from disk, MIME-by-extension (then sniff), base64-encoded
 * A source that cannot be read/fetched throws {@link BrandAssetError} (fail loud — a logo the
 * caller explicitly pointed at is a real misconfiguration, unlike a flaky item-photo host).
 */
export async function resolveAssetToDataUri(src: string): Promise<string> {
  const trimmed = src.trim();
  if (trimmed.startsWith("data:")) return trimmed;

  if (/^https?:\/\//i.test(trimmed)) {
    let response: Response;
    try {
      response = await globalThis.fetch(trimmed);
    } catch (cause) {
      throw new BrandAssetError(`brand logo could not be fetched from "${src}".`, { cause });
    }
    if (!response.ok) {
      throw new BrandAssetError(`brand logo fetch failed (HTTP ${response.status}) for "${src}".`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const mime = mimeFor(response.headers.get("content-type"), buffer);
    if (!mime) throw new BrandAssetError(`brand logo at "${src}" is not a recognised image type.`);
    return `data:${mime};base64,${buffer.toString("base64")}`;
  }

  const path = trimmed.startsWith("file://") ? fileURLToPath(trimmed) : trimmed;
  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch (cause) {
    throw new BrandAssetError(`brand logo could not be read from "${src}".`, { cause });
  }
  const mime = mimeForPath(path, buffer);
  if (!mime) throw new BrandAssetError(`brand logo at "${src}" is not a recognised image type.`);
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

/**
 * Input normalization for the Node composition root: if `input.brand.logo.src` is present and not
 * already a `data:` URI, resolve it and return a shallow-rebuilt input carrying the data-URI.
 * Any other input is returned unchanged. Full validation still happens inside the pure engine.
 */
export async function normalizeBrandLogo(input: unknown): Promise<unknown> {
  if (typeof input !== "object" || input === null) return input;
  const brand = (input as { brand?: unknown }).brand;
  if (typeof brand !== "object" || brand === null) return input;
  const logo = (brand as { logo?: unknown }).logo;
  if (typeof logo !== "object" || logo === null) return input;
  const src = (logo as { src?: unknown }).src;
  if (typeof src !== "string" || src.trim() === "") return input;

  const dataUri = await resolveAssetToDataUri(src);
  return {
    ...(input as Record<string, unknown>),
    brand: {
      ...(brand as Record<string, unknown>),
      logo: { ...(logo as Record<string, unknown>), src: dataUri },
    },
  };
}
