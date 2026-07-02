import { wrapOpenAI } from "braintrust";
import OpenAI from "openai";
import { z } from "zod";

import type { ReasoningSetting } from "../../config/models";
import { LlmContractError } from "../../domain/errors";

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
   * Per-request timeout (ms) set on the SDK client; bounds a stalled call so a dead socket can't
   * hang the run for minutes (the SDK default is 10 min). Left unset → the SDK default applies.
   */
  timeoutMs?: number;
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
  const client = new OpenAI({
    apiKey: options.apiKey,
    baseURL: options.baseURL ?? OPENROUTER_BASE_URL,
    defaultHeaders,
    ...(options.timeoutMs !== undefined ? { timeout: options.timeoutMs } : {}),
  });
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
 * Run one structured-output completion through OpenRouter and return validated data, with a
 * single re-ask on a contract mismatch. Throws {@link LlmContractError} if it still fails.
 */
export async function requestStructured<T>(client: OpenAI, call: StructuredCall<T>): Promise<T> {
  const jsonSchema = toStrictJsonSchema(call.schema);
  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: call.system },
    { role: "user", content: call.user as OpenAI.Chat.ChatCompletionUserMessageParam["content"] },
  ];

  let lastError = "";
  let prevOutcome: string | undefined;
  const maxAttempts = 2;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const trace = traceForAttempt(call.trace, attempt, maxAttempts, prevOutcome);
    const body = {
      model: call.model,
      messages,
      ...(call.temperature !== undefined ? { temperature: call.temperature } : {}),
      ...(call.seed !== undefined ? { seed: call.seed } : {}),
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

    const completion = await client.chat.completions.create(
      body as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming,
    );
    const content = completion.choices[0]?.message.content ?? "";

    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(content);
    } catch {
      lastError = "response was not valid JSON";
      prevOutcome = "invalid_json";
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
    messages.push({ role: "assistant", content });
    messages.push({
      role: "user",
      content: `Your previous response did not match the schema (${lastError}). Return ONLY corrected JSON.`,
    });
  }

  throw new LlmContractError(
    `OpenRouter response failed the "${call.schemaName}" contract: ${lastError}`,
    {
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

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(() => resolve(), ms);
  });
}

/**
 * A plain text completion (used by the painter, which returns HTML, not JSON). Sets an explicit
 * `max_tokens` so a large/dense board isn't cut off, and retries the two failure modes a long,
 * dense paint hits: an EMPTY body (a thinking model can burn its whole budget on reasoning before
 * emitting) and a TRANSIENT network drop (the provider closes the socket mid-stream — which the
 * SDK won't retry once the body has started). A persistent empty returns "" (the painter throws a
 * PaintError); a persistent / non-transient network error propagates.
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
    /** Base backoff between retries (ms), grown linearly per attempt. Set to 0 in tests. */
    retryBackoffMs?: number;
    /** OpenRouter Broadcast `session_id` — groups a run's calls for external observability. */
    sessionId?: string;
    /** OpenRouter Broadcast `trace` metadata — forwarded to configured observability destinations. */
    trace?: Record<string, unknown>;
    /** Per-call reasoning control, mapped to OpenRouter's `reasoning` field. */
    reasoning?: ReasoningSetting;
  },
): Promise<string> {
  const baseBody = {
    model: params.model,
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
  const maxAttempts = 3;
  let last = "";
  let prevOutcome: string | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    // Stamp the trace per attempt so a retried paint is legible in Braintrust (attempt N of M, and
    // why the previous attempt failed) — the exact context missing when a dense board retries.
    const trace = traceForAttempt(params.trace, attempt, maxAttempts, prevOutcome);
    const body = {
      ...baseBody,
      ...(trace !== undefined ? { trace } : {}),
    } as unknown as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;
    let completion: OpenAI.Chat.ChatCompletion;
    try {
      completion = await client.chat.completions.create(body);
    } catch (error) {
      // Retry a transient socket drop a few times (with linear backoff) before giving up; a real
      // error (4xx/5xx/auth/bad request) is not transient and propagates immediately.
      if (isTransientNetworkError(error) && attempt < maxAttempts - 1) {
        prevOutcome = "transient_network";
        await delay(backoff * (attempt + 1));
        continue;
      }
      throw error;
    }
    last = completion.choices[0]?.message.content ?? "";
    if (last.trim() !== "") return last;
    // Empty body: loop and re-ask (a reasoning model may have spent its budget before emitting).
    prevOutcome = "empty_body";
  }
  return last;
}
