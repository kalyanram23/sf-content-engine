import { wrapOpenAI } from "braintrust";
import OpenAI from "openai";
import { z } from "zod";

import type { ReasoningSetting } from "../../config/models";
import { LlmContractError } from "../../domain/errors";
import type { Logger, UsageSink } from "../../ports/services";

/**
 * OpenRouter access via the OpenAI-compatible SDK (D1) with structured-output HARDENING
 * (D11): strict JSON Schema, `provider.require_parameters` so OpenRouter only routes to
 * providers that honour the schema, response validation at the boundary, and one bounded
 * re-ask before throwing a typed `LlmContractError`. Never returns unvalidated data.
 */

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";

export interface OpenRouterClientOptions {
  apiKey: string;
  baseURL?: string;
  /** Optional OpenRouter attribution headers. */
  appUrl?: string;
  appName?: string;
  /**
   * Per-request timeout (ms) for the PRIMARY model's attempts; bounds a stalled call so a dead socket
   * can't hang the run for minutes (the SDK default is 10 min). Left unset → the SDK default applies.
   * The real per-attempt bound is our own {@link attemptTimeoutSignal} (armed for the whole body read);
   * this value is the primary's budget for it.
   */
  timeoutMs?: number;
  /**
   * Per-request timeout (ms) for a FALLBACK model's attempts (config `fallbackRequestTimeoutMs`).
   * The fallback is a slower-but-steadier model whose healthy generation of a big board legitimately
   * exceeds the primary's leash, so it gets a longer one via {@link attemptTimeoutSignal}. Left unset →
   * the fallback shares `timeoutMs`, exactly as before this budget existed.
   */
  fallbackTimeoutMs?: number;
  /**
   * Opt into client-side Braintrust auto-instrumentation (`wrapOpenAI` traces every call to the
   * initialized Braintrust logger). Off by default: the always-on tracing path is OpenRouter
   * Broadcast (`session_id` + `trace` on the request body), which needs no external logger. Only
   * enable when the caller has initialized Braintrust (`initLogger`) and wants client-side spans too.
   */
  braintrust?: boolean;
}

export function createOpenRouterClient(options: OpenRouterClientOptions): OpenAI {
  const defaultHeaders: Record<string, string> = {};
  if (options.appUrl) defaultHeaders["HTTP-Referer"] = options.appUrl;
  if (options.appName) defaultHeaders["X-Title"] = options.appName;
  // The SDK's own `timeout` only bounds TIME-TO-HEADERS (see attemptTimeoutSignal) — it never caps the
  // body read, which our AbortSignal owns. Set it to the LARGER of the two per-attempt budgets so it
  // can never undercut the fallback's longer leash even before headers arrive; the true per-attempt,
  // per-model bound is armed below by attemptTimeoutSignal, so the primary is still held to `timeoutMs`.
  const sdkTimeoutMs =
    options.timeoutMs !== undefined
      ? Math.max(options.timeoutMs, options.fallbackTimeoutMs ?? options.timeoutMs)
      : options.fallbackTimeoutMs;
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL ?? OPENROUTER_BASE_URL,
    defaultHeaders,
    ...(sdkTimeoutMs !== undefined ? { timeout: sdkTimeoutMs } : {}),
    // The SDK's own auto-retry (default 2) would silently stack up to 3× the configured timeout onto a
    // stalled call. Disable it: our config-driven `resilience` loop (requestStructured / requestText)
    // is the single retry authority, so each HTTP attempt respects its per-model budget exactly and the
    // wall-clock is a legible attempts × budget.
    maxRetries: 0,
  });
  // Stamp the per-model per-attempt budgets that attemptTimeoutSignal reads: the primary uses
  // `timeoutMs`, a fallback model uses the longer `fallbackTimeoutMs`. These are read off the client so
  // no per-call budget plumbing through the adapters is needed (mirrors how `timeout` is read). Keeping
  // them distinct from the SDK's header-only `timeout` lets the primary stay on its short leash while
  // the SDK timeout is set to the larger budget above.
  const budgets = client as unknown as {
    perAttemptTimeoutMs?: number;
    fallbackAttemptTimeoutMs?: number;
  };
  if (options.timeoutMs !== undefined) budgets.perAttemptTimeoutMs = options.timeoutMs;
  if (options.fallbackTimeoutMs !== undefined)
    budgets.fallbackAttemptTimeoutMs = options.fallbackTimeoutMs;
  // Auto-instrument only when the caller opted into Braintrust; otherwise return the plain client so
  // the default tracing path is OpenRouter Broadcast alone (no external-logger dependency).
  return options.braintrust ? wrapOpenAI(client) : client;
}

type JsonObject = Record<string, unknown>;

/** Recursively enforce `additionalProperties:false` + full `required` for strict mode (D11). */
function enforceStrict(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(enforceStrict);
  if (node && typeof node === "object") {
    const obj = node as JsonObject;
    if (obj["type"] === "object" && obj["properties"] && typeof obj["properties"] === "object") {
      const props = obj["properties"] as JsonObject;
      obj["additionalProperties"] = false;
      obj["required"] = Object.keys(props);
    }
    for (const key of Object.keys(obj)) obj[key] = enforceStrict(obj[key]);
  }
  return node;
}

export function toStrictJsonSchema(schema: z.ZodType): JsonObject {
  return enforceStrict(z.toJSONSchema(schema)) as JsonObject;
}

export type UserContent =
  | string
  | Array<{ type: "text"; text: string } | { type: "image_url"; image_url: { url: string } }>;

/**
 * Per-call token usage from one OpenRouter completion, for cost visibility. OpenRouter now returns
 * `usage` on EVERY response (the old `usage:{ include:true }` opt-in is deprecated — do not send it).
 * `cachedTokens` (prompt-cache hits) and `reasoningTokens` (thinking tokens billed INSIDE the
 * completion) are OpenRouter/OpenAI extras the SDK types don't declare — present only when the
 * provider reports them. `attempt` is 1-based so a retry/re-ask's spend is attributable (that is
 * where hidden double-spend lives).
 */
export interface LlmUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cachedTokens?: number;
  reasoningTokens?: number;
  attempt?: number;
}

/**
 * Pull {@link LlmUsage} off a completion, reading OpenRouter's `*_tokens_details` extras via bracket
 * access + defensive typing (the SDK types don't cover them). Returns undefined when the response
 * carried no usage, so a provider that omits it stays silent rather than reporting zeros.
 */
function extractUsage(completion: { usage?: unknown }, attempt: number): LlmUsage | undefined {
  const usage = completion.usage;
  if (usage === null || typeof usage !== "object") return undefined;
  const u = usage as Record<string, unknown>;
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);
  const detail = (v: unknown, key: string): number | undefined =>
    v !== null && typeof v === "object" ? num((v as Record<string, unknown>)[key]) : undefined;
  const cached = detail(u["prompt_tokens_details"], "cached_tokens");
  const reasoning = detail(u["completion_tokens_details"], "reasoning_tokens");
  return {
    promptTokens: num(u["prompt_tokens"]) ?? 0,
    completionTokens: num(u["completion_tokens"]) ?? 0,
    totalTokens: num(u["total_tokens"]) ?? 0,
    ...(cached !== undefined ? { cachedTokens: cached } : {}),
    ...(reasoning !== undefined ? { reasoningTokens: reasoning } : {}),
    attempt: attempt + 1,
  };
}

/**
 * Build an `onUsage` callback ({@link StructuredCall} / {@link requestText}) that logs one debug line
 * of per-call token usage (role + model + counts + attempt) so a run has cost visibility. Returns
 * undefined when no logger is present — callers conditionally spread it, keeping the no-logger path
 * unchanged.
 */
export function logUsage(
  logger: Logger | undefined,
  role: string,
  model: string,
): ((usage: LlmUsage) => void) | undefined {
  if (logger === undefined) return undefined;
  return (usage) => {
    const parts = [
      `prompt=${usage.promptTokens}`,
      `completion=${usage.completionTokens}`,
      `total=${usage.totalTokens}`,
      ...(usage.cachedTokens !== undefined ? [`cached=${usage.cachedTokens}`] : []),
      ...(usage.reasoningTokens !== undefined ? [`reasoning=${usage.reasoningTokens}`] : []),
      ...(usage.attempt !== undefined ? [`attempt=${usage.attempt}`] : []),
    ];
    logger.debug(`usage ${role} (${model}): ${parts.join(" ")}`);
  };
}

/**
 * Compose the per-call `onUsage` sink an adapter passes into a {@link StructuredCall} /
 * {@link requestText}: it fires the existing {@link logUsage} debug line AND records a structured
 * {@link UsageEvent} on the optional {@link UsageSink} (D28). BOTH fire — the debug line is
 * unchanged. `primaryModel` is the role's primary id; the actual model that served the call arrives
 * per-attempt (the fallback id when the primary was exhausted), so the event carries the true model
 * and a `fallback` flag. Returns undefined when neither a logger nor a sink is present, so the
 * no-telemetry path stays exactly as before (callers conditionally spread it).
 */
export function buildUsageReporter(
  logger: Logger | undefined,
  usageSink: UsageSink | undefined,
  role: string,
  primaryModel: string,
): ((usage: LlmUsage, model: string) => void) | undefined {
  const log = logUsage(logger, role, primaryModel);
  if (log === undefined && usageSink === undefined) return undefined;
  return (usage, model) => {
    log?.(usage);
    void usageSink?.record({
      role,
      model,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
      ...(usage.cachedTokens !== undefined ? { cachedTokens: usage.cachedTokens } : {}),
      ...(usage.reasoningTokens !== undefined ? { reasoningTokens: usage.reasoningTokens } : {}),
      ...(usage.attempt !== undefined ? { attempt: usage.attempt } : {}),
      fallback: model !== primaryModel,
    });
  };
}

/**
 * A role's resilience policy as the adapters pass it into a call (config-as-data, sourced from
 * `ModelRouting.resilience` / `.fallback`). `maxAttempts` caps tries against the PRIMARY model;
 * `fallback` is an optional model id tried once those attempts are spent. Spread into a
 * {@link StructuredCall} / {@link requestText} params via {@link resilienceFields}.
 */
export interface RoleResilience {
  /** Attempts against the primary model before falling back / giving up (default 2). */
  maxAttempts?: number;
  /** Optional fallback model id, tried after the primary exhausts its attempts. */
  fallback?: string;
}

/** Spread a role's {@link RoleResilience} into a call's params, emitting only the set keys
 * (exactOptionalPropertyTypes: never pass an explicit `undefined`). */
export function resilienceFields(r: RoleResilience | undefined): {
  maxAttempts?: number;
  fallback?: string;
} {
  return {
    ...(r?.maxAttempts !== undefined ? { maxAttempts: r.maxAttempts } : {}),
    ...(r?.fallback !== undefined ? { fallback: r.fallback } : {}),
  };
}

/**
 * A per-attempt {@link AbortSignal} that bounds the WHOLE request — connection AND body read — to
 * the client's configured timeout. The OpenAI SDK's own `timeout` only bounds time-to-headers: its
 * `fetchWithTimeout` clears the timer in a `finally` the instant the response headers arrive, so a
 * provider that returns 200 headers early and then streams a slow NON-stream body (a long GLM paint)
 * runs UNBOUNDED past that point — measured at 600–1154s single spans against a 300s cap in eval
 * run 4 (23/55 calls overran). Passing our own `AbortSignal.timeout` as the request `signal` stays
 * armed through the body read and aborts the underlying fetch, so every attempt is genuinely capped.
 * The cap is read off the client (`createOpenRouterClient` stamps `perAttemptTimeoutMs` /
 * `fallbackAttemptTimeoutMs`), so no per-call plumbing through the adapters is needed. The budget is
 * selected by `modelIndex`: the PRIMARY (index 0) gets `perAttemptTimeoutMs` (config
 * `requestTimeoutMs`); a FALLBACK (index > 0) gets the longer `fallbackAttemptTimeoutMs` (config
 * `fallbackRequestTimeoutMs`) — the fallback is a slower/steadier model whose healthy generation of a
 * big board legitimately exceeds the primary's leash, so sharing it guillotined every big-board
 * fallback attempt at the primary cap. Each falls back to the SDK client `timeout` when its explicit
 * budget is absent (a duck-typed test client), preserving the pre-split behaviour. Returns undefined
 * when no positive budget is found → unbounded, exactly as before.
 */
function attemptTimeoutSignal(client: OpenAI, modelIndex: number): AbortSignal | undefined {
  const c = client as unknown as {
    timeout?: unknown;
    perAttemptTimeoutMs?: unknown;
    fallbackAttemptTimeoutMs?: unknown;
  };
  const positive = (v: unknown): number | undefined =>
    typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
  const budget =
    modelIndex > 0
      ? (positive(c.fallbackAttemptTimeoutMs) ??
        positive(c.perAttemptTimeoutMs) ??
        positive(c.timeout))
      : (positive(c.perAttemptTimeoutMs) ?? positive(c.timeout));
  return budget !== undefined ? AbortSignal.timeout(budget) : undefined;
}

export interface StructuredCall<T> {
  model: string;
  system: string;
  user: UserContent;
  schema: z.ZodType<T>;
  schemaName: string;
  /**
   * Optional sampling temperature. Omitted by default: many current reasoning models
   * (GPT-5.x, o-series) reject `temperature`, and under `provider.require_parameters` sending
   * it filters out every endpoint → a 404. Only set it for models known to support it.
   */
  temperature?: number;
  /** Optional fixed seed for best-effort reproducibility (D15). */
  seed?: number;
  /** OpenRouter Broadcast `session_id` — groups a run's calls for external observability. */
  sessionId?: string;
  /** OpenRouter Broadcast `trace` metadata — forwarded to configured observability destinations. */
  trace?: Record<string, unknown>;
  /** Per-call reasoning control, mapped to OpenRouter's `reasoning` field by {@link toReasoningBody}. */
  reasoning?: ReasoningSetting;
  /**
   * Optional `max_tokens` cap (per-role config, D1). OpenRouter reserves it as credit collateral and
   * counts reasoning tokens INSIDE it, so an unbounded structured call over-reserves. Omitted → no cap.
   */
  maxTokens?: number;
  /** Attempts against the primary model before the fallback / giving up (config-as-data). Default 2. */
  maxAttempts?: number;
  /** Optional fallback model id, tried once the primary exhausts {@link maxAttempts} (config-as-data). */
  fallback?: string;
  /**
   * Optional token-usage sink; fired once per attempt that produced a response, with the ACTUAL
   * model that served the attempt (the fallback id after a fallback) for accurate attribution.
   */
  onUsage?: (usage: LlmUsage, model: string) => void;
}

/**
 * Stamp per-attempt debugging context onto a COPY of the broadcast `trace`, so every retry / re-ask
 * is self-describing in Braintrust (and any OpenRouter Broadcast destination): which `attempt` this
 * is, the `max_attempts` budget, and — on a retry — `prev_outcome`, why the previous attempt failed
 * (a transient socket drop, an empty body the model burned on reasoning, invalid JSON, or a schema
 * mismatch). This is a DIFFERENT axis from `trace.iteration` (the QA loop's paint/repair cycle):
 * `attempt` is the retry/re-ask WITHIN a single call. Returns undefined when there is no base trace,
 * so the no-correlation path stays byte-identical (tracing remains opt-in).
 */
function traceForAttempt(
  trace: Record<string, unknown> | undefined,
  attempt: number,
  maxAttempts: number,
  prevOutcome: string | undefined,
): Record<string, unknown> | undefined {
  if (trace === undefined) return undefined;
  return {
    ...trace,
    attempt: attempt + 1,
    max_attempts: maxAttempts,
    ...(prevOutcome !== undefined ? { prev_outcome: prevOutcome } : {}),
  };
}

/**
 * Map the neutral {@link ReasoningSetting} (engine config) to OpenRouter's `reasoning` request
 * field: camel→snake for `maxTokens`, everything else passed through. Only set keys are emitted.
 */
function toReasoningBody(setting: ReasoningSetting): Record<string, unknown> {
  return {
    ...(setting.enabled !== undefined ? { enabled: setting.enabled } : {}),
    ...(setting.effort !== undefined ? { effort: setting.effort } : {}),
    ...(setting.maxTokens !== undefined ? { max_tokens: setting.maxTokens } : {}),
    ...(setting.exclude !== undefined ? { exclude: setting.exclude } : {}),
  };
}

/**
 * Run one structured-output completion through OpenRouter and return validated data. Each model
 * (the primary, then an optional {@link StructuredCall.fallback}) gets up to
 * {@link StructuredCall.maxAttempts} tries (default 2): the first re-asks with the parse/schema
 * error appended, and — because a persistently empty or non-conforming model shouldn't sink the run
 * — the fallback model is engaged once the primary's budget is spent. Throws
 * {@link LlmContractError} only after every model has exhausted its attempts.
 */
export async function requestStructured<T>(client: OpenAI, call: StructuredCall<T>): Promise<T> {
  const jsonSchema = toStrictJsonSchema(call.schema);
  const maxAttempts = call.maxAttempts ?? 2;
  const models = call.fallback !== undefined ? [call.model, call.fallback] : [call.model];

  let lastError = "";
  // The underlying error object behind the most recent create()-thrown transient failure (a raw
  // SyntaxError from a truncated body, an abort, or a socket drop). Attached as the `cause` of the
  // exhaustion LlmContractError so a body-parse failure is never surfaced as a bare SyntaxError; reset
  // to undefined by the in-band invalid_json/schema_mismatch outcomes so it always tracks the latest.
  let lastCause: unknown;
  for (const [modelIndex, model] of models.entries()) {
    // A fresh conversation per model: the fallback shouldn't inherit another model's failed turns.
    const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
      { role: "system", content: call.system },
      { role: "user", content: call.user as OpenAI.Chat.ChatCompletionUserMessageParam["content"] },
    ];
    // Seed the fallback model's first attempt with why we switched, for legible tracing.
    let prevOutcome: string | undefined = modelIndex > 0 ? "primary_exhausted" : undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const trace = traceForAttempt(call.trace, attempt, maxAttempts, prevOutcome);
      const body = {
        model,
        messages,
        ...(call.temperature !== undefined ? { temperature: call.temperature } : {}),
        ...(call.seed !== undefined ? { seed: call.seed } : {}),
        ...(call.maxTokens !== undefined ? { max_tokens: call.maxTokens } : {}),
        // OpenRouter-only correlation (consumed before forwarding): groups + tags traces for Broadcast.
        ...(call.sessionId !== undefined ? { session_id: call.sessionId } : {}),
        ...(trace !== undefined ? { trace } : {}),
        ...(call.reasoning !== undefined ? { reasoning: toReasoningBody(call.reasoning) } : {}),
        response_format: {
          type: "json_schema",
          json_schema: { name: call.schemaName, strict: true, schema: jsonSchema },
        },
        // OpenRouter-only: route only to providers that honour response_format (loud, not silent).
        provider: { require_parameters: true },
      };

      // Bound this attempt: our AbortSignal caps the WHOLE request (the SDK's own timeout only bounds
      // time-to-headers, not the slow body read). A timeout or a transient socket drop consumes the
      // attempt and re-asks / falls back within the budget rather than throwing — a real 4xx/5xx/auth
      // error still propagates (a different attempt can't fix a bad request). The budget is picked by
      // model: the primary gets `requestTimeoutMs`, a fallback gets the longer `fallbackRequestTimeoutMs`.
      const signal = attemptTimeoutSignal(client, modelIndex);
      let completion: OpenAI.Chat.ChatCompletion;
      try {
        completion = await client.chat.completions.create(
          body as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
          signal ? { signal } : {},
        );
      } catch (error) {
        // A per-attempt timeout consumes the attempt and re-asks / falls back within the budget
        // (like a socket drop), rather than throwing. Detect it robustly: the armed signal's
        // `aborted` flag first, THEN a defensive shape check — the SDK surfaces a slow-body abort as a
        // raw `AbortError` DOMException that `isTransientNetworkError` does not recognise and that can
        // arrive decoupled from our signal object, so `signal.aborted` alone let it escape (attempt 1,
        // no retries). A real 4xx/5xx/auth error still propagates (a retry can't fix a bad request).
        const timedOut =
          signal !== undefined && (signal.aborted === true || isAbortLikeError(error));
        // A truncated/empty response body makes the SDK's own JSON.parse throw a raw SyntaxError (the
        // same disease D51 fixed for aborts — see isBodyParseError); classify it as a transient network
        // drop so the attempt is consumed and the fallback engaged, never rethrown terminally.
        const bodyParse = isBodyParseError(error);
        if (timedOut || bodyParse || isTransientNetworkError(error)) {
          lastError = timedOut ? "request timed out before a response" : "transient network error";
          prevOutcome = timedOut ? "timeout" : "transient_network";
          lastCause = error;
          continue;
        }
        throw error;
      }
      // Report every attempt's usage — a re-ask spends again, and that double-spend is otherwise blind.
      const usage = extractUsage(completion, attempt);
      if (usage !== undefined) call.onUsage?.(usage, model);
      const content = completion.choices[0]?.message.content ?? "";

      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(content);
      } catch {
        lastError = "response was not valid JSON";
        prevOutcome = "invalid_json";
        lastCause = undefined;
        messages.push({ role: "assistant", content });
        messages.push({
          role: "user",
          content: `Your previous response was not valid JSON. Return ONLY a JSON object matching the schema "${call.schemaName}".`,
        });
        continue;
      }

      const result = call.schema.safeParse(parsedJson);
      if (result.success) return result.data;

      lastError = result.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
      prevOutcome = "schema_mismatch";
      lastCause = undefined;
      messages.push({ role: "assistant", content });
      messages.push({
        role: "user",
        content: `Your previous response did not match the schema (${lastError}). Return ONLY corrected JSON.`,
      });
    }
  }

  throw new LlmContractError(
    `OpenRouter response failed the "${call.schemaName}" contract: ${lastError}`,
    {
      ...(lastCause !== undefined ? { cause: lastCause } : {}),
      details: { model: call.model, schemaName: call.schemaName },
    },
  );
}

/**
 * Transient network failures worth retrying — a dropped/closed/reset socket or connection timeout,
 * including a mid-stream drop the SDK does NOT retry on its own (a long, dense paint can have its
 * socket closed after the response body has started → undici "terminated" / UND_ERR_SOCKET).
 */
function isTransientNetworkError(error: unknown): boolean {
  const e = error as { name?: string; code?: string; message?: string; cause?: { code?: string } };
  const code = e.code ?? e.cause?.code ?? "";
  const message = (e.message ?? "").toLowerCase();
  return (
    e.name === "APIConnectionError" ||
    e.name === "APIConnectionTimeoutError" ||
    code === "UND_ERR_SOCKET" ||
    code === "ECONNRESET" ||
    code === "ECONNREFUSED" ||
    code === "ETIMEDOUT" ||
    message.includes("terminated") ||
    message.includes("other side closed") ||
    message.includes("socket hang up")
  );
}

/**
 * An ABORTED in-flight request — our per-attempt {@link attemptTimeoutSignal} fired, or the fetch
 * that carries it was aborted mid-body. The OpenAI SDK does NOT surface this as one stable class:
 * a PRE-header abort is wrapped as its own `APIUserAbortError` ("Request was aborted."), but an abort
 * during the SLOW response-body parse — the exact case this signal exists to bound (headers arrive
 * fast, a non-stream body then streams slowly) — is thrown OUTSIDE the SDK's `makeRequest`
 * abort-wrapping, so it escapes as the RAW undici `DOMException` (`name:"AbortError"`, message "This
 * operation was aborted", legacy numeric `code:20`). {@link isTransientNetworkError} does not
 * recognise that raw shape (no `UND_ERR_SOCKET`/`terminated`/`socket` markers), so relying on
 * `signal.aborted` alone let a bare AbortError propagate terminally on attempt 1 when the abort was
 * decoupled from our signal object. This predicate is the shape backstop: it matches an abort by
 * `instanceof APIUserAbortError`, by error/DOMException name ("AbortError"/"TimeoutError"), by
 * constructor name, by message, or cause-chained. Since this codebase passes NO external abort
 * signals, callers gate it on an armed timeout signal (`signal !== undefined`) → every such abort is
 * a per-attempt TIMEOUT, never a user cancellation.
 */
function isAbortLikeError(error: unknown, depth = 0): boolean {
  if (error === null || typeof error !== "object" || depth > 3) return false;
  if (error instanceof OpenAI.APIUserAbortError) return true;
  const e = error as { name?: unknown; message?: unknown; cause?: unknown };
  const name = typeof e.name === "string" ? e.name : "";
  const ctorName =
    typeof (error as { constructor?: { name?: unknown } }).constructor?.name === "string"
      ? (error as { constructor: { name: string } }).constructor.name
      : "";
  const message = typeof e.message === "string" ? e.message.toLowerCase() : "";
  if (
    name === "AbortError" ||
    name === "TimeoutError" ||
    ctorName === "APIUserAbortError" ||
    message.includes("aborted")
  ) {
    return true;
  }
  // Cause-chained abort (e.g. a wrapper that carries the AbortError as its `cause`).
  return e.cause !== undefined && e.cause !== error ? isAbortLikeError(e.cause, depth + 1) : false;
}

/**
 * A response-body-PARSE failure thrown by the SDK's `create()` call — D51's disease in a different
 * costume. The OpenAI SDK reads the HTTP response body and runs `JSON.parse` on it INSIDE its own
 * `makeRequest`; when the provider (e.g. z-ai/glm-5.2 via OpenRouter) cuts the connection mid-body or
 * returns a truncated/empty body, that internal `JSON.parse` throws a raw `SyntaxError` ("Unexpected
 * end of JSON input") that is NEITHER an `APIError` nor abort-shaped — so both
 * {@link isTransientNetworkError} and {@link isAbortLikeError} miss it and the retry loop rethrew it
 * as terminal (observed twice in one eval run: zero retries, no fallback, one board burned 1714s then
 * died). A truncated body is the same transient class as a socket drop, so classify it as one:
 * consume the attempt, retry with backoff, and engage the fallback. `instanceof SyntaxError` is the
 * load-bearing check — the message is only illustrative and must NOT be matched on. This is called
 * ONLY from the `create()` catch, so it never sees the SyntaxErrors our OWN `JSON.parse` sites throw
 * (structured content parsing, which has its own invalid_json re-ask handling below).
 */
function isBodyParseError(error: unknown): boolean {
  return error instanceof SyntaxError;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

/**
 * A plain text completion (used by the painter, which returns HTML, not JSON). `max_tokens` is
 * caller-supplied (per-role config; omitted → the provider default applies). Each model (primary,
 * then an optional `fallback`) gets up to `maxAttempts` tries (default 3), retrying the three failure
 * modes a long, dense paint hits: an EMPTY body (a thinking model can burn its whole budget on
 * reasoning before emitting), a TRUNCATED body (finish_reason "length" — the provider cut the
 * completion at the token cap, leaving a stub that would ship as a blank board), and a TRANSIENT
 * network drop (the provider closes the socket mid-stream — which the SDK won't retry once the body
 * has started). Once the primary is exhausted (persistent empty/truncated or persistent transient),
 * the fallback model is engaged. A persistent empty/truncated across all models returns the last body
 * (empty, or a truncated stub — downstream QA + routing handle a bad final board, and an empty one
 * makes the painter throw a PaintError); a NON-transient error (4xx/5xx/auth/bad request) propagates
 * immediately without a fallback (a different model can't fix a bad request); a persistent transient
 * across all models is re-thrown.
 */
export async function requestText(
  client: OpenAI,
  params: {
    model: string;
    system: string;
    user: UserContent;
    temperature?: number;
    seed?: number;
    maxTokens?: number;
    /** Attempts against the primary model before the fallback / giving up (config-as-data). Default 3. */
    maxAttempts?: number;
    /** Optional fallback model id, tried once the primary exhausts its attempts (config-as-data). */
    fallback?: string;
    /** Base backoff between retries (ms), grown linearly per attempt. Set to 0 in tests. */
    retryBackoffMs?: number;
    /** OpenRouter Broadcast `session_id` — groups a run's calls for external observability. */
    sessionId?: string;
    /** OpenRouter Broadcast `trace` metadata — forwarded to configured observability destinations. */
    trace?: Record<string, unknown>;
    /** Per-call reasoning control, mapped to OpenRouter's `reasoning` field. */
    reasoning?: ReasoningSetting;
    /**
     * Optional token-usage sink; fired once per attempt that produced a response, with the ACTUAL
     * model that served the attempt (the fallback id after a fallback) for accurate attribution.
     */
    onUsage?: (usage: LlmUsage, model: string) => void;
  },
): Promise<string> {
  const baseBody = {
    ...(params.temperature !== undefined ? { temperature: params.temperature } : {}),
    ...(params.seed !== undefined ? { seed: params.seed } : {}),
    ...(params.maxTokens !== undefined ? { max_tokens: params.maxTokens } : {}),
    // OpenRouter-only correlation (consumed before forwarding): groups + tags traces for Broadcast.
    ...(params.sessionId !== undefined ? { session_id: params.sessionId } : {}),
    ...(params.reasoning !== undefined ? { reasoning: toReasoningBody(params.reasoning) } : {}),
    messages: [
      { role: "system", content: params.system },
      {
        role: "user",
        content: params.user as OpenAI.Chat.ChatCompletionUserMessageParam["content"],
      },
    ],
  };

  const backoff = params.retryBackoffMs ?? 1500;
  const maxAttempts = params.maxAttempts ?? 3;
  const models = params.fallback !== undefined ? [params.model, params.fallback] : [params.model];

  let last = "";
  // The last transient error seen with no usable response after it — re-thrown if every model is
  // exhausted without ever producing content (a different model can recover a socket-level drop
  // when it routes to a different provider, so we fall through rather than throw eagerly).
  let pendingTransient: unknown;
  // Whether {@link pendingTransient} is a per-attempt TIMEOUT (vs a socket drop). On full exhaustion
  // a timeout is surfaced as a legible wrapped error rather than the SDK's bare AbortError.
  let pendingTimedOut = false;
  // Whether {@link pendingTransient} is a truncated/empty-body PARSE failure — a raw SyntaxError the
  // SDK threw from its OWN JSON.parse of the response body (see isBodyParseError). Like a timeout, on
  // full exhaustion it is surfaced as a legible wrapped error, never a bare SyntaxError.
  let pendingBodyParse = false;
  for (const [modelIndex, model] of models.entries()) {
    // Seed the fallback model's first attempt with why we switched, for legible tracing.
    let prevOutcome: string | undefined = modelIndex > 0 ? "primary_exhausted" : undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      // Stamp the trace per attempt so a retried paint is legible in Braintrust (attempt N of M, and
      // why the previous attempt failed) — the exact context missing when a dense board retries.
      const trace = traceForAttempt(params.trace, attempt, maxAttempts, prevOutcome);
      const body = {
        model,
        ...baseBody,
        ...(trace !== undefined ? { trace } : {}),
      } as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
      // Bound this attempt: our AbortSignal caps the WHOLE request. The SDK's own `timeout` only
      // bounds time-to-headers (it clears its timer once headers arrive), so a provider that streams a
      // slow non-stream body — a long paint — was previously unbounded (600–1154s spans, eval run 4).
      // The budget is picked by model: the primary gets `requestTimeoutMs`, a fallback the longer
      // `fallbackRequestTimeoutMs` — a slower/steadier model whose big-board paint legitimately overran
      // the shared 300s cap and was killed on every attempt (tonight's traces: 22/29 fallback calls).
      const signal = attemptTimeoutSignal(client, modelIndex);
      let completion: OpenAI.Chat.ChatCompletion;
      try {
        completion = await client.chat.completions.create(body, signal ? { signal } : {});
      } catch (error) {
        // A per-attempt timeout (our signal fired) or a transient socket drop is retried a few times
        // (with linear backoff) before moving on to the fallback; a real error (4xx/5xx/auth/bad
        // request) is not transient and propagates immediately. Detect the timeout robustly: the armed
        // signal's `aborted` flag first, THEN a defensive shape check — the SDK surfaces a slow-body
        // abort as a raw `AbortError` DOMException that `isTransientNetworkError` misses and that can
        // arrive decoupled from our signal, so `signal.aborted` alone let it escape (attempt 1, no
        // retries, no fallback — the eval-run crash this fixes).
        const timedOut =
          signal !== undefined && (signal.aborted === true || isAbortLikeError(error));
        // A truncated/empty response body makes the SDK's own JSON.parse throw a raw SyntaxError (the
        // same disease D51 fixed for aborts — see isBodyParseError); classify it as a transient network
        // drop so the attempt is consumed, retried with backoff, and the fallback engaged.
        const bodyParse = isBodyParseError(error);
        if (timedOut || bodyParse || isTransientNetworkError(error)) {
          pendingTransient = error;
          pendingTimedOut = timedOut;
          pendingBodyParse = bodyParse;
          prevOutcome = timedOut ? "timeout" : "transient_network";
          if (attempt < maxAttempts - 1) {
            await delay(backoff * (attempt + 1));
            continue;
          }
          // This model exhausted its attempts on a timeout/transient error → try the fallback (if any).
          break;
        }
        throw error;
      }
      pendingTransient = undefined;
      pendingTimedOut = false;
      pendingBodyParse = false;
      // Report every attempt that produced a response (incl. an empty-body reasoning burn) — the retry
      // path is where hidden spend accumulates; a network drop threw/broke above, so it has no usage.
      const usage = extractUsage(completion, attempt);
      if (usage !== undefined) params.onUsage?.(usage, model);
      last = completion.choices[0]?.message.content ?? "";
      // A "length" finish_reason means the provider CUT the completion at the max_tokens cap — the
      // body is a truncated stub (a thinking model can burn the whole budget on reasoning, then emit
      // a fragment that would ship as a blank board). Treat truncation exactly like an empty body:
      // don't return it, retry / fall back. (Truncated JSON on the structured path already fails
      // schema parse and retries, so this only guards the free-text painter path.)
      const truncated = completion.choices[0]?.finish_reason === "length";
      if (last.trim() !== "" && !truncated) return last;
      // Empty or truncated body: loop and re-ask (a reasoning model may have spent its budget before
      // emitting, or hit the token cap mid-output).
      prevOutcome = truncated ? "truncated" : "empty_body";
    }
    // This model gave only empty bodies or exhausted a transient drop; the loop advances to the
    // fallback model, if one is configured.
  }
  // Every model is spent. If the last failure was a transient network error and nothing usable ever
  // came back, surface it; otherwise return the last (empty) body for the caller (painter) to handle.
  if (pendingTransient !== undefined && last.trim() === "") {
    // A bare AbortError ("This operation was aborted") or a raw SyntaxError ("Unexpected end of JSON
    // input") is illegible upstream — wrap an exhaustion-by-timeout or by-body-parse in a clear error
    // (keeping the original as `cause`); a socket-drop exhaustion still re-throws the original
    // transient error (its `code` aids upstream handling). Name BOTH models tried when a fallback was
    // engaged, so a crashed board's log tells the whole story (primary AND the rescue that also failed).
    const modelsTried =
      params.fallback !== undefined
        ? `${params.model}, then fallback ${params.fallback}`
        : params.model;
    if (pendingTimedOut) {
      throw new Error(
        `OpenRouter request for "${modelsTried}" timed out on every attempt before returning a response`,
        { cause: pendingTransient },
      );
    }
    if (pendingBodyParse) {
      throw new Error(
        `OpenRouter response for "${modelsTried}" could not be parsed on any attempt (truncated or empty body)`,
        { cause: pendingTransient },
      );
    }
    throw pendingTransient;
  }
  return last;
}
