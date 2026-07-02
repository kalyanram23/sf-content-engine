/** Shared image MIME detection for the Node image adapters (fetcher + brand asset resolver). */

/** Trust the server Content-Type when it's a real image type; otherwise sniff magic bytes. */
export function mimeFor(contentType: string | null, buffer: Buffer): string | null {
  const declared = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
  if (declared && declared.startsWith("image/")) return declared;
  return sniffMime(buffer);
}

/** Resolve a local file's MIME by extension first, then fall back to magic-byte sniffing. */
export function mimeForPath(path: string, buffer: Buffer): string | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const byExt: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
  };
  return byExt[ext] ?? sniffMime(buffer);
}

export function sniffMime(b: Buffer): string | null {
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
