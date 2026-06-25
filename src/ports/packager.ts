import type { ResolvedTheme } from "../domain/types";

export interface PackageRequest {
  /** Raw, painter-authored HTML (Tailwind classes, data-motion, bindings). */
  html: string;
  theme: ResolvedTheme;
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
