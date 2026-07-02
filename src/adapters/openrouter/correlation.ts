import type { RequestCorrelation } from "../../ports/correlation";

/**
 * OpenRouter Broadcast correlation fields derived from a neutral {@link RequestCorrelation}.
 * `session_id` groups a board's whole QA loop (and is OpenRouter's sticky-routing key, so it
 * also helps prompt-cache hits); `trace` is arbitrary metadata forwarded to every configured
 * Broadcast destination as `trace.metadata.*` span attributes. Both are OpenRouter-level fields
 * consumed before the request is forwarded to the upstream model.
 */
export interface BroadcastFields {
  /** OpenRouter `session_id` — `<restaurant-slug>:<screen-or-role>:<runId>`. */
  sessionId?: string;
  /** OpenRouter `trace` object — `trace_id`/`trace_name` plus custom correlation keys. */
  trace?: Record<string, unknown>;
}

const TRACE_NAME = "content-engine";

/** Lowercase, dash-collapse a restaurant name into a session-id-safe slug; `menu` when empty. */
function slugify(value: string | undefined): string {
  if (value === undefined) return "menu";
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return slug === "" ? "menu" : slug;
}

/**
 * Build the OpenRouter Broadcast fields for one call. `role` ("plan"/"paint"/"critique"/"repair")
 * is known by the adapter, not the engine, so it is passed separately. The session id is only
 * emitted when a `runId` is present (without it there is nothing to keep sessions unique per run).
 */
export function buildBroadcast(
  correlation: RequestCorrelation | undefined,
  role: string,
): BroadcastFields {
  if (correlation === undefined) return {};
  const { runId, restaurant, screenId, iteration } = correlation;

  const trace: Record<string, unknown> = { trace_name: TRACE_NAME, role };
  if (runId !== undefined) trace["trace_id"] = runId;
  if (restaurant !== undefined) trace["restaurant"] = restaurant;
  if (screenId !== undefined) trace["board"] = screenId;
  if (iteration !== undefined) trace["iteration"] = iteration;

  const fields: BroadcastFields = { trace };
  if (runId !== undefined) {
    fields.sessionId = `${slugify(restaurant)}:${screenId ?? role}:${runId}`;
  }
  return fields;
}
