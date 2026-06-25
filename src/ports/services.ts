/**
 * Ambient service ports — the engine's only access to time, identity, and logging, so the
 * core stays deterministic and free of global state (build brief). Fakes are fixed/counter
 * based; real impls use the system clock and a uuid/counter.
 */

/** Wall-clock access. Used only for report timestamps. */
export interface Clock {
  now(): Date;
}

/** Deterministic-friendly id source (screen ids, finding ids, graph thread ids). */
export interface IdGenerator {
  /** Returns a new id with the given prefix, e.g. `next("screen") → "screen-1"`. */
  next(prefix: string): string;
}

export interface Logger {
  debug(message: string, meta?: Record<string, unknown>): void;
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
  error(message: string, meta?: Record<string, unknown>): void;
}
