/**
 * Ambient service ports — the engine's only access to time, identity, and logging, so the
 * core stays deterministic and free of global state (build brief). Fakes are fixed/counter
 * based; real impls use the system clock and a uuid/counter.
 */

import type { QaFinding } from "../domain/types";

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

/** One scored QA-loop candidate, surfaced for debugging/inspection (off by default). */
export interface DebugCapture {
  /** 0-based board index in the plan. */
  screenIndex: number;
  screenId: string;
  /** Paint/repair cycle this candidate came from. */
  iteration: number;
  /** Routing decision the score node made for this candidate. */
  route: string;
  /** Comparable score total (higher is better). */
  score: number;
  passed: boolean;
  /** Raw painter markup (pre-package). */
  rawHtml: string;
  /** Self-contained packaged artifact that was rendered. */
  packagedHtml: string;
  /** PNG of the render, base64. */
  screenshotBase64: string;
  findings: readonly QaFinding[];
}

/**
 * Optional sink for every scored candidate, so a caller can dump each iteration's artifacts
 * (HTML/screenshot/findings) for inspection. Injected like {@link Logger}; the pure core only
 * calls it when present, so it never affects engine output (D15).
 */
export interface DebugSink {
  capture(candidate: DebugCapture): void | Promise<void>;
}
