import type { Clock, IdGenerator, Logger } from "../../ports/services";

/** A fixed clock for deterministic report timestamps. */
export class FakeClock implements Clock {
  constructor(private readonly iso = "2026-06-22T00:00:00.000Z") {}
  now(): Date {
    return new Date(this.iso);
  }
}

/** A deterministic counter-based id source (e.g. `screen-1`, `run-1`). */
export class FakeIdGenerator implements IdGenerator {
  private readonly counters = new Map<string, number>();
  next(prefix: string): string {
    const n = (this.counters.get(prefix) ?? 0) + 1;
    this.counters.set(prefix, n);
    return `${prefix}-${n}`;
  }
}

/** A logger that discards everything. */
export const noopLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
};

/** A logger that records entries for assertions. */
export class ArrayLogger implements Logger {
  readonly entries: { level: string; message: string; meta?: Record<string, unknown> }[] = [];
  private push(level: string, message: string, meta?: Record<string, unknown>): void {
    this.entries.push(meta ? { level, message, meta } : { level, message });
  }
  debug(message: string, meta?: Record<string, unknown>): void {
    this.push("debug", message, meta);
  }
  info(message: string, meta?: Record<string, unknown>): void {
    this.push("info", message, meta);
  }
  warn(message: string, meta?: Record<string, unknown>): void {
    this.push("warn", message, meta);
  }
  error(message: string, meta?: Record<string, unknown>): void {
    this.push("error", message, meta);
  }
}
