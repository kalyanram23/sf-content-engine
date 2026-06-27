import type { CanonicalItem, ResolvedTheme } from "../domain/types";

export interface PackageRequest {
  /** Raw, painter-authored HTML (Tailwind classes, data-motion, bindings). */
  html: string;
  theme: ResolvedTheme;
  /**
   * The screen's items with images already resolved to data-URIs. The packager fills each
   * carousel `<img data-img-item data-img-index>` placeholder with the matching data-URI, so
   * the painter never emits a (remote) src and the artifact stays offline-safe (§5.1).
   */
  items: CanonicalItem[];
}

/**
 * Deterministic packaging (spec §5.2, D4): compile Tailwind → static CSS, inline
 * fonts/assets as data-URIs, and inline the Motion runtime + the `data-motion`→preset glue
 * (D14) — guaranteeing a self-contained, offline-safe artifact regardless of what the
 * painter wrote. Returns the packaged HTML that QA renders and that ultimately ships.
 */
export interface Packager {
  package(request: PackageRequest): Promise<string>;
}
