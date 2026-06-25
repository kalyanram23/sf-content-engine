/**
 * Structured error hierarchy. Every failure the engine raises is a `ContentEngineError`
 * with a stable `code` (for programmatic handling) and optional structured `details`.
 * Boundary validation failures wrap Zod issues; no silent failures (build brief).
 */

export type ContentEngineErrorCode =
  | "VALIDATION"
  | "UNSUPPORTED_CONSTRAINT"
  | "THEME_NOT_FOUND"
  | "PAINT"
  | "PACKAGING"
  | "RENDER"
  | "LLM_CONTRACT"
  | "QA_BUDGET"
  | "CONFIG"
  | "INTERNAL";

export interface ContentEngineErrorOptions {
  readonly cause?: unknown;
  readonly details?: Readonly<Record<string, unknown>>;
}

export class ContentEngineError extends Error {
  readonly code: ContentEngineErrorCode;
  readonly details?: Readonly<Record<string, unknown>>;

  constructor(code: ContentEngineErrorCode, message: string, options?: ContentEngineErrorOptions) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    if (options?.details !== undefined) this.details = options.details;
    // Restore prototype chain for instanceof across transpilation targets.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** A value failed schema validation at a boundary (input, config, or LLM contract). */
export class ValidationError extends ContentEngineError {
  constructor(message: string, options?: ContentEngineErrorOptions) {
    super("VALIDATION", message, options);
  }
}

/** A requested constraint combination is not supported in this version (e.g. screens > 1). */
export class UnsupportedConstraintError extends ContentEngineError {
  constructor(message: string, options?: ContentEngineErrorOptions) {
    super("UNSUPPORTED_CONSTRAINT", message, options);
  }
}

/** The theme repository has no preset for the requested id. */
export class ThemeNotFoundError extends ContentEngineError {
  constructor(message: string, options?: ContentEngineErrorOptions) {
    super("THEME_NOT_FOUND", message, options);
  }
}

/** The painter failed to produce usable HTML. */
export class PaintError extends ContentEngineError {
  constructor(message: string, options?: ContentEngineErrorOptions) {
    super("PAINT", message, options);
  }
}

/** Packaging (Tailwind compile / inlining / self-containment) failed. */
export class PackagingError extends ContentEngineError {
  constructor(message: string, options?: ContentEngineErrorOptions) {
    super("PACKAGING", message, options);
  }
}

/** The browser failed to render or observe the artifact. */
export class RenderError extends ContentEngineError {
  constructor(message: string, options?: ContentEngineErrorOptions) {
    super("RENDER", message, options);
  }
}

/** An LLM returned output that did not satisfy its structured contract (D11). */
export class LlmContractError extends ContentEngineError {
  constructor(message: string, options?: ContentEngineErrorOptions) {
    super("LLM_CONTRACT", message, options);
  }
}

/**
 * The QA loop exhausted its iteration budget. The engine ships the best-scoring screen
 * and flags it rather than throwing this in normal operation (§5.6); reserved for
 * configurations that opt into strict failure.
 */
export class QaBudgetError extends ContentEngineError {
  constructor(message: string, options?: ContentEngineErrorOptions) {
    super("QA_BUDGET", message, options);
  }
}

/** Engine configuration was invalid (e.g. a model id not on the structured-output allowlist). */
export class ConfigError extends ContentEngineError {
  constructor(message: string, options?: ContentEngineErrorOptions) {
    super("CONFIG", message, options);
  }
}
