/**
 * A valid 1×1 transparent PNG as a data-URI — the offline-safe fallback when a remote item
 * photo can't be fetched/inlined. Using a real (non-empty) 1×1 PNG keeps `naturalWidth > 0`
 * under the network-disabled render, so the rendered image-slot check still sees a loaded
 * image instead of a broken one. Pure data; importable by the core, adapters, and fakes.
 */
export const PLACEHOLDER_IMAGE_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

export const PLACEHOLDER_IMAGE_DATA_URI = `data:image/png;base64,${PLACEHOLDER_IMAGE_BASE64}`;

/** True for references that are already inline/offline-safe (no network needed to resolve). */
export function isInlineImageRef(ref: string): boolean {
  return /^(data:|blob:|#)/i.test(ref.trim());
}
