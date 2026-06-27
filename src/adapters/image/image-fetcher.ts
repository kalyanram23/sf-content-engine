import type { ImageFetcher } from "../../ports/image-fetcher";
import { isInlineImageRef } from "../../util/placeholder-image";

/**
 * Node image fetcher (S9 adapter): downloads each remote photo and returns it as an
 * offline-safe `data:` URI so the packaged artifact never references the network (spec §5.1).
 * Resilient by design — a URL that fails, times out, or exceeds the size cap is simply omitted
 * from the result map; the pipeline substitutes an offline placeholder, so a flaky photo host
 * never hard-fails generation. Uses Node's global `fetch`/`Buffer` (Node ≥18) — no new dep.
 */
export interface NodeImageFetcherOptions {
  /** Per-request timeout in ms (default 8000). */
  timeoutMs?: number;
  /**
   * Skip (and placeholder) any image larger than this many bytes (default 4 MB). Real menu
   * photography routinely runs 0.5–1.5 MB, so the cap is a runaway guard, not a quality gate.
   */
  maxBytes?: number;
}

export class NodeImageFetcher implements ImageFetcher {
  private readonly timeoutMs: number;
  private readonly maxBytes: number;

  constructor(options: NodeImageFetcherOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 8000;
    this.maxBytes = options.maxBytes ?? 4_000_000;
  }

  async fetch(urls: readonly string[]): Promise<Map<string, string>> {
    const unique = [...new Set(urls)].filter((u) => !isInlineImageRef(u));
    const out = new Map<string, string>();
    await Promise.all(
      unique.map(async (url) => {
        const dataUri = await this.fetchOne(url);
        if (dataUri) out.set(url, dataUri);
      }),
    );
    return out;
  }

  private async fetchOne(url: string): Promise<string | null> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await globalThis.fetch(url, { signal: controller.signal });
      if (!response.ok) return null;
      const buffer = Buffer.from(await response.arrayBuffer());
      if (buffer.byteLength === 0 || buffer.byteLength > this.maxBytes) return null;
      const mime = mimeFor(response.headers.get("content-type"), buffer);
      if (!mime) return null;
      return `data:${mime};base64,${buffer.toString("base64")}`;
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Trust the server Content-Type when it's a real image type; otherwise sniff magic bytes. */
function mimeFor(contentType: string | null, buffer: Buffer): string | null {
  const declared = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
  if (declared && declared.startsWith("image/")) return declared;
  return sniffMime(buffer);
}

function sniffMime(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return "image/png";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38)
    return "image/gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return "image/webp";
  const head = b.subarray(0, 256).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<?xml") || head.startsWith("<svg")) return "image/svg+xml";
  return null;
}
