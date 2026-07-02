/**
 * Neutral request-correlation context, threaded from the engine to the LLM ports so a single
 * run's calls can be grouped and filtered in an external observability platform (OpenRouter
 * Broadcast → LangSmith/Langfuse/OTLP, etc.). Deliberately wire-format-agnostic: the core only
 * knows the run/board/restaurant it is working on; the OpenRouter adapter turns this into the
 * provider's `session_id` + `trace` fields (`adapters/openrouter/correlation.ts`). Every field
 * is optional so callers/tests that don't care about tracing are unaffected.
 */
export interface RequestCorrelation {
  /** Stable id for one `generate()`/`plan()` invocation — the "unique" part of a session id. */
  runId?: string;
  /** Human-readable restaurant/menu name; slugified into the session id, kept raw in the trace. */
  restaurant?: string;
  /** The board this call belongs to (absent for run-level calls like the planner). */
  screenId?: string;
  /** The paint/repair cycle this call belongs to. */
  iteration?: number;
}
