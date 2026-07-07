import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";

import { LlmContractError } from "../../domain/errors";
import {
  createOpenRouterClient,
  requestStructured,
  requestText,
  toStrictJsonSchema,
  type LlmUsage,
} from "./client";

/** A duck-typed OpenAI client that replays scripted message contents (no network). */
function mockClient(contents: string[]): OpenAI {
  let i = 0;
  return {
    chat: {
      completions: {
        create: () => {
          const content = contents[Math.min(i, contents.length - 1)];
          i += 1;
          return Promise.resolve({ choices: [{ message: { content } }] });
        },
      },
    },
  } as unknown as OpenAI;
}

/**
 * A duck-typed client that dispatches scripted responses BY the request body's `model` field, so a
 * fallback model can be scripted separately from the primary. Each script entry is either a string
 * (returned as message content) or an Error (rejected with); consumed per model, clamped to the last.
 * `calls()` returns the ordered list of model ids the client was asked for.
 */
function modelAwareClient(
  scripts: Record<string, Array<string | Error>>,
  timeout?: number,
): {
  client: OpenAI;
  calls: () => string[];
} {
  const idx: Record<string, number> = {};
  const calls: string[] = [];
  const client = {
    ...(timeout !== undefined ? { timeout } : {}),
    chat: {
      completions: {
        create: (body: { model: string }) => {
          const model = body.model;
          calls.push(model);
          const script = scripts[model] ?? [""];
          const i = idx[model] ?? 0;
          idx[model] = i + 1;
          const entry = script[Math.min(i, script.length - 1)];
          if (entry instanceof Error) return Promise.reject(entry);
          return Promise.resolve({ choices: [{ message: { content: entry } }] });
        },
      },
    },
  } as unknown as OpenAI;
  return { client, calls: () => calls };
}

/** A fresh transient socket-drop error (the mid-stream close undici surfaces as UND_ERR_SOCKET). */
function socketDrop(): Error {
  return Object.assign(new Error("terminated"), { code: "UND_ERR_SOCKET" });
}

/**
 * The EXACT error shape the OpenAI SDK (v6.44) surfaces when a per-attempt timeout aborts the SLOW
 * response-body read: the abort fires during body parsing, OUTSIDE the SDK's `makeRequest`
 * abort-wrapping, so undici's `controller.abort()` (no reason) escapes as a RAW `DOMException` with
 * `name:"AbortError"` and message "This operation was aborted" (verified against node_modules/openai).
 * It carries no `code`/`terminated` marker, so `isTransientNetworkError` does NOT recognise it — the
 * regression this reproduces, where it propagated terminally on attempt 1 instead of retrying.
 */
function sdkAbortError(): Error {
  return new DOMException("This operation was aborted", "AbortError");
}

/**
 * The error the OpenAI SDK surfaces when the HTTP response body it received is truncated or empty:
 * the SDK runs `JSON.parse` on the body INSIDE its own `makeRequest`, so a provider that cuts the
 * connection mid-body (z-ai/glm-5.2 via OpenRouter, observed twice in one eval run) makes that parse
 * throw a raw `SyntaxError("Unexpected end of JSON input")` — neither an APIError nor abort-shaped, so
 * `isTransientNetworkError`/`isAbortLikeError` both miss it and the loop rethrew it terminally. This
 * reproduces that shape; the fix classifies it as a transient network drop (`isBodyParseError`).
 */
function bodyParseError(): Error {
  return new SyntaxError("Unexpected end of JSON input");
}

/** A duck-typed client that records the request body it was called with, then returns `content`. */
function capturingClient(content: string): { client: OpenAI; body: () => Record<string, unknown> } {
  let captured: Record<string, unknown> = {};
  const client = {
    chat: {
      completions: {
        create: (body: Record<string, unknown>) => {
          captured = body;
          return Promise.resolve({ choices: [{ message: { content } }] });
        },
      },
    },
  } as unknown as OpenAI;
  return { client, body: () => captured };
}

const schema = z.object({ answer: z.string(), score: z.number().optional() });

describe("toStrictJsonSchema (D11)", () => {
  it("enforces additionalProperties:false and lists every property as required", () => {
    const js = toStrictJsonSchema(schema) as {
      additionalProperties: boolean;
      required: string[];
      properties: Record<string, unknown>;
    };
    expect(js.additionalProperties).toBe(false);
    expect(new Set(js.required)).toEqual(new Set(["answer", "score"]));
  });
});

describe("createOpenRouterClient timeout + retry (per-attempt cap, single retry authority)", () => {
  it("sets the configured per-request timeout on the SDK client", () => {
    const client = createOpenRouterClient({ apiKey: "test", timeoutMs: 42000 }) as unknown as {
      timeout: number;
    };
    expect(client.timeout).toBe(42000);
  });

  it("disables the SDK's built-in auto-retry (maxRetries:0) so timeouts can't silently stack", () => {
    // The SDK default is 2 auto-retries with a per-attempt timeout — that is the wall-clock-overrun
    // bug. Our config-driven resilience loop is the single retry authority instead.
    const client = createOpenRouterClient({ apiKey: "test", timeoutMs: 1000 }) as unknown as {
      maxRetries: number;
    };
    expect(client.maxRetries).toBe(0);
  });

  it("stamps distinct primary + fallback per-attempt budgets and lifts the SDK header timeout to the larger", () => {
    const client = createOpenRouterClient({
      apiKey: "test",
      timeoutMs: 300000,
      fallbackTimeoutMs: 900000,
    }) as unknown as {
      timeout: number;
      perAttemptTimeoutMs: number;
      fallbackAttemptTimeoutMs: number;
    };
    // The per-model abort budgets attemptTimeoutSignal reads: primary short, fallback long.
    expect(client.perAttemptTimeoutMs).toBe(300000);
    expect(client.fallbackAttemptTimeoutMs).toBe(900000);
    // The SDK's header-only timeout is lifted to the LARGER budget so it can never undercut the
    // fallback's time-to-headers; the primary's short body leash is enforced by the abort signal.
    expect(client.timeout).toBe(900000);
  });
});

describe("requestStructured (D11)", () => {
  const call = {
    model: "openai/gpt-4o-mini",
    system: "s",
    user: "u",
    schema,
    schemaName: "answer",
  };

  it("returns validated data on a conforming response", async () => {
    const client = mockClient(['{"answer":"hi","score":1}']);
    await expect(requestStructured(client, call)).resolves.toEqual({ answer: "hi", score: 1 });
  });

  it("re-asks once and recovers from an initial bad response", async () => {
    const client = mockClient(["not json", '{"answer":"ok"}']);
    await expect(requestStructured(client, call)).resolves.toEqual({ answer: "ok" });
  });

  it("throws a typed LlmContractError when the contract is never met", async () => {
    const client = mockClient(['{"wrong":"shape"}', '{"still":"wrong"}']);
    await expect(requestStructured(client, call)).rejects.toBeInstanceOf(LlmContractError);
  });

  it("engages the fallback model once the primary exhausts its attempts (invalid JSON)", async () => {
    const { client, calls } = modelAwareClient({
      "primary/model": ["not json"], // clamps → invalid on every primary attempt
      "fallback/model": ['{"answer":"from-fallback"}'],
    });
    await expect(
      requestStructured(client, { ...call, model: "primary/model", fallback: "fallback/model" }),
    ).resolves.toEqual({ answer: "from-fallback" });
    // Primary tried twice (default budget), THEN the fallback once — order proves the fallback is
    // reached only after the primary is spent.
    expect(calls()).toEqual(["primary/model", "primary/model", "fallback/model"]);
  });

  it("respects a custom per-role maxAttempts budget before falling back / throwing", async () => {
    const { client, calls } = modelAwareClient({ "primary/model": ["nope"] });
    await expect(
      requestStructured(client, { ...call, model: "primary/model", maxAttempts: 3 }),
    ).rejects.toBeInstanceOf(LlmContractError);
    expect(calls()).toEqual(["primary/model", "primary/model", "primary/model"]);
  });

  it("bounds each structured attempt by the client timeout and gives up cleanly instead of hanging", async () => {
    // Every attempt hangs; the per-attempt AbortSignal (15ms, read off the client) must abort each
    // one so the call terminates with a typed contract error rather than hanging the run.
    let calls = 0;
    const client = {
      timeout: 15,
      chat: {
        completions: {
          create: (_body: unknown, options?: { signal?: AbortSignal }) => {
            calls += 1;
            return new Promise((_resolve, reject) => {
              options?.signal?.addEventListener("abort", () =>
                reject(options.signal?.reason ?? new Error("aborted")),
              );
            });
          },
        },
      },
    } as unknown as OpenAI;
    await expect(requestStructured(client, call)).rejects.toBeInstanceOf(LlmContractError);
    // Both attempts (the default budget) were bounded + consumed — no unbounded wait.
    expect(calls).toBe(2);
  });

  it("classifies an SDK-shaped abort (raw AbortError) as a transient timeout and re-asks (structured)", async () => {
    // Regression: the SDK surfaces a slow-body timeout as a RAW AbortError DOMException that arrives
    // with our per-attempt signal armed but NOT flagged aborted (the abort is decoupled from it).
    // Relying on signal.aborted alone let it propagate on attempt 1; the shape backstop must classify
    // it as a timeout so the loop re-asks and recovers.
    let calls = 0;
    const client = {
      timeout: 300000, // signal armed, but it never fires here → signal.aborted stays false
      chat: {
        completions: {
          create: () => {
            calls += 1;
            if (calls === 1) return Promise.reject(sdkAbortError());
            return Promise.resolve({
              choices: [{ message: { content: '{"answer":"recovered"}' } }],
              usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
            });
          },
        },
      },
    } as unknown as OpenAI;
    const seen: LlmUsage[] = [];
    await expect(
      requestStructured(client, { ...call, onUsage: (u) => seen.push(u) }),
    ).resolves.toEqual({ answer: "recovered" });
    expect(calls).toBe(2);
    // The aborted attempt has no usage; the recovered re-ask reports attempt 2 (numbering intact).
    expect(seen.map((u) => u.attempt)).toEqual([2]);
  });

  it("throws a legible timeout contract error when every attempt + fallback aborts (structured)", async () => {
    const { client, calls } = modelAwareClient(
      { "primary/model": [sdkAbortError()], "fallback/model": [sdkAbortError()] },
      300000,
    );
    const err = await requestStructured(client, {
      ...call,
      model: "primary/model",
      fallback: "fallback/model",
    }).catch((e: unknown) => e);
    // A typed, legible contract error — never the bare undici AbortError.
    expect(err).toBeInstanceOf(LlmContractError);
    expect((err as Error).name).not.toBe("AbortError");
    expect(String((err as Error).message)).toMatch(/timed out before a response/);
    // Primary exhausted its 2-attempt budget, then the fallback was engaged — all consumed by timeout.
    expect(calls()).toEqual(["primary/model", "primary/model", "fallback/model", "fallback/model"]);
  });

  it("classifies an SDK response-body-parse failure (raw SyntaxError) as transient and re-asks (structured)", async () => {
    // Regression: the SDK runs JSON.parse on the HTTP response body; a truncated/empty body makes it
    // throw a raw SyntaxError that is neither an APIError nor abort-shaped. It must be treated as a
    // transient network drop — consume the attempt and re-ask — not rethrown terminally (the crash).
    let calls = 0;
    const client = {
      chat: {
        completions: {
          create: () => {
            calls += 1;
            if (calls === 1) return Promise.reject(bodyParseError());
            return Promise.resolve({
              choices: [{ message: { content: '{"answer":"recovered"}' } }],
              usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
            });
          },
        },
      },
    } as unknown as OpenAI;
    const seen: LlmUsage[] = [];
    await expect(
      requestStructured(client, { ...call, onUsage: (u) => seen.push(u) }),
    ).resolves.toEqual({ answer: "recovered" });
    expect(calls).toBe(2);
    // The parse-failed attempt threw (no usage); the recovered re-ask reports attempt 2 (intact).
    expect(seen.map((u) => u.attempt)).toEqual([2]);
  });

  it("engages the fallback model when the primary persistently fails to parse its body (structured)", async () => {
    const { client, calls } = modelAwareClient({
      "primary/model": [bodyParseError()], // clamps → SyntaxError on every primary attempt
      "fallback/model": ['{"answer":"from-fallback"}'],
    });
    await expect(
      requestStructured(client, { ...call, model: "primary/model", fallback: "fallback/model" }),
    ).resolves.toEqual({ answer: "from-fallback" });
    // Primary tried twice, THEN the fallback — the body-parse failure engages the fallback like any
    // other transient network failure.
    expect(calls()).toEqual(["primary/model", "primary/model", "fallback/model"]);
  });

  it("surfaces a legible contract error with the SyntaxError as cause when every attempt + fallback fails to parse (structured)", async () => {
    const { client, calls } = modelAwareClient({
      "primary/model": [bodyParseError()],
      "fallback/model": [bodyParseError()],
    });
    const err = await requestStructured(client, {
      ...call,
      model: "primary/model",
      fallback: "fallback/model",
    }).catch((e: unknown) => e);
    // A typed, legible contract error — never a bare SyntaxError — carrying the original as cause.
    expect(err).toBeInstanceOf(LlmContractError);
    expect((err as Error).name).not.toBe("SyntaxError");
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(SyntaxError);
    expect(calls()).toEqual(["primary/model", "primary/model", "fallback/model", "fallback/model"]);
  });

  it("merges session_id and trace into the request body when provided (Broadcast)", async () => {
    const { client, body } = capturingClient('{"answer":"hi"}');
    await requestStructured(client, {
      ...call,
      sessionId: "menu:screen-1:run-abc",
      trace: { trace_id: "run-abc", role: "plan" },
    });
    expect(body()["session_id"]).toBe("menu:screen-1:run-abc");
    expect(body()["trace"]).toEqual({
      trace_id: "run-abc",
      role: "plan",
      attempt: 1,
      max_attempts: 2,
    });
  });

  it("omits session_id and trace from the body when not provided", async () => {
    const { client, body } = capturingClient('{"answer":"hi"}');
    await requestStructured(client, call);
    expect(body()).not.toHaveProperty("session_id");
    expect(body()).not.toHaveProperty("trace");
  });

  it("maps the reasoning setting into the request body (camel→snake max_tokens)", async () => {
    const { client, body } = capturingClient('{"answer":"hi"}');
    await requestStructured(client, { ...call, reasoning: { enabled: true, maxTokens: 4000 } });
    expect(body()["reasoning"]).toEqual({ enabled: true, max_tokens: 4000 });
  });

  it("emits max_tokens in the request body when a cap is set, omits it otherwise", async () => {
    const capped = capturingClient('{"answer":"hi"}');
    await requestStructured(capped.client, { ...call, maxTokens: 8000 });
    expect(capped.body()["max_tokens"]).toBe(8000);

    const uncapped = capturingClient('{"answer":"hi"}');
    await requestStructured(uncapped.client, call);
    expect(uncapped.body()).not.toHaveProperty("max_tokens");
  });

  it("fires onUsage with mapped fields incl. cached + reasoning tokens (bracket-accessed extras)", async () => {
    const client = {
      chat: {
        completions: {
          create: () =>
            Promise.resolve({
              choices: [{ message: { content: '{"answer":"hi"}' } }],
              usage: {
                prompt_tokens: 120,
                completion_tokens: 30,
                total_tokens: 150,
                prompt_tokens_details: { cached_tokens: 80 },
                completion_tokens_details: { reasoning_tokens: 12 },
              },
            }),
        },
      },
    } as unknown as OpenAI;
    const seen: LlmUsage[] = [];
    await requestStructured(client, { ...call, onUsage: (u) => seen.push(u) });
    expect(seen).toEqual([
      {
        promptTokens: 120,
        completionTokens: 30,
        totalTokens: 150,
        cachedTokens: 80,
        reasoningTokens: 12,
        attempt: 1,
      },
    ]);
  });

  it("stays silent when a response carries no usage (no zeros reported)", async () => {
    const client = mockClient(['{"answer":"hi"}']);
    let fired = false;
    await requestStructured(client, {
      ...call,
      onUsage: () => {
        fired = true;
      },
    });
    expect(fired).toBe(false);
  });

  it("reports usage on BOTH the failed first attempt and the recovered re-ask (double-spend)", async () => {
    let i = 0;
    const contents = ["not json", '{"answer":"ok"}'];
    const client = {
      chat: {
        completions: {
          create: () => {
            const content = contents[Math.min(i, contents.length - 1)];
            i += 1;
            return Promise.resolve({
              choices: [{ message: { content } }],
              usage: { prompt_tokens: 5, completion_tokens: 5, total_tokens: 10 },
            });
          },
        },
      },
    } as unknown as OpenAI;
    const seen: LlmUsage[] = [];
    await requestStructured(client, { ...call, onUsage: (u) => seen.push(u) });
    expect(seen.map((u) => u.attempt)).toEqual([1, 2]);
  });

  it("stamps each re-ask attempt with attempt number, budget, and prev_outcome (Braintrust)", async () => {
    const traces: unknown[] = [];
    let i = 0;
    const contents = ["not json", '{"answer":"ok"}'];
    const client = {
      chat: {
        completions: {
          create: (body: Record<string, unknown>) => {
            traces.push(body["trace"]);
            const content = contents[Math.min(i, contents.length - 1)];
            i += 1;
            return Promise.resolve({ choices: [{ message: { content } }] });
          },
        },
      },
    } as unknown as OpenAI;
    await requestStructured(client, {
      ...call,
      trace: { trace_id: "run-abc", role: "plan" },
    });
    expect(traces).toEqual([
      { trace_id: "run-abc", role: "plan", attempt: 1, max_attempts: 2 },
      {
        trace_id: "run-abc",
        role: "plan",
        attempt: 2,
        max_attempts: 2,
        prev_outcome: "invalid_json",
      },
    ]);
  });
});

describe("requestText resilience", () => {
  const base = { model: "m", system: "s", user: "u", retryBackoffMs: 0 };

  it("retries a transient mid-stream socket drop and recovers", async () => {
    let calls = 0;
    const client = {
      chat: {
        completions: {
          create: () => {
            calls += 1;
            if (calls === 1) {
              return Promise.reject(
                Object.assign(new Error("terminated"), { code: "UND_ERR_SOCKET" }),
              );
            }
            return Promise.resolve({ choices: [{ message: { content: "<div>ok</div>" } }] });
          },
        },
      },
    } as unknown as OpenAI;
    await expect(requestText(client, base)).resolves.toContain("ok");
    expect(calls).toBe(2);
  });

  it("aborts a hanging request at the client-configured timeout and proceeds to the next attempt", async () => {
    // Attempt 1 hangs forever (the eval-run-4 paint that streamed a slow body for 600–1154s past the
    // ineffective SDK header-only timeout). The per-attempt AbortSignal.timeout (20ms, read off the
    // client) must fire, reject the call, and the resilience loop must recover on attempt 2 — the
    // whole test finishes in well under the would-be hang.
    let calls = 0;
    const client = {
      timeout: 20,
      chat: {
        completions: {
          create: (_body: unknown, options?: { signal?: AbortSignal }) => {
            calls += 1;
            if (calls === 1) {
              return new Promise((_resolve, reject) => {
                options?.signal?.addEventListener("abort", () =>
                  reject(options.signal?.reason ?? new Error("aborted")),
                );
              });
            }
            return Promise.resolve({ choices: [{ message: { content: "<div>ok</div>" } }] });
          },
        },
      },
    } as unknown as OpenAI;
    await expect(requestText(client, { ...base, maxAttempts: 2 })).resolves.toContain("ok");
    expect(calls).toBe(2);
  });

  it("passes a per-attempt abort signal derived from the client timeout to create()", async () => {
    const seen: Array<AbortSignal | undefined> = [];
    const client = {
      timeout: 300000,
      chat: {
        completions: {
          create: (_body: unknown, options?: { signal?: AbortSignal }) => {
            seen.push(options?.signal);
            return Promise.resolve({ choices: [{ message: { content: "<div>ok</div>" } }] });
          },
        },
      },
    } as unknown as OpenAI;
    await expect(requestText(client, base)).resolves.toContain("ok");
    expect(seen[0]).toBeInstanceOf(AbortSignal);
  });

  it("classifies an SDK-shaped abort (raw AbortError) as a transient timeout and recovers, even when signal.aborted is false", async () => {
    // Regression (eval-run crash): a slow-body timeout surfaces as a RAW AbortError DOMException while
    // our per-attempt signal is armed but NOT flagged aborted (the abort is decoupled from it).
    // Relying on signal.aborted alone let the bare AbortError propagate on attempt 1 with zero retries
    // and no fallback — the shape backstop must retry it like a socket drop.
    let calls = 0;
    const client = {
      timeout: 300000, // signal armed; it never fires here → signal.aborted stays false at the catch
      chat: {
        completions: {
          create: () => {
            calls += 1;
            if (calls === 1) return Promise.reject(sdkAbortError());
            return Promise.resolve({
              choices: [{ message: { content: "<div>ok</div>" } }],
              usage: { prompt_tokens: 10, completion_tokens: 40, total_tokens: 50 },
            });
          },
        },
      },
    } as unknown as OpenAI;
    const seen: LlmUsage[] = [];
    await expect(requestText(client, { ...base, onUsage: (u) => seen.push(u) })).resolves.toContain(
      "ok",
    );
    expect(calls).toBe(2);
    // The aborted attempt threw (no usage); the recovered attempt reports attempt 2 (numbering intact).
    expect(seen.map((u) => u.attempt)).toEqual([2]);
  });

  it("throws a legible timeout error (not a bare AbortError) when every attempt + fallback aborts", async () => {
    const { client, calls } = modelAwareClient(
      { "primary/model": [sdkAbortError()], "fallback/model": [sdkAbortError()] },
      300000,
    );
    const err = await requestText(client, {
      ...base,
      model: "primary/model",
      fallback: "fallback/model",
      maxAttempts: 2,
    }).catch((e: unknown) => e);
    // Not the bare undici AbortError — a clear, attributable timeout message with the original as cause.
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).not.toBe("AbortError");
    expect(String((err as Error).message)).toMatch(/timed out on every attempt/);
    // The exhaustion message names BOTH models tried (primary AND the engaged fallback), so a crashed
    // board's log tells the whole story — not just the primary that started it.
    expect(String((err as Error).message)).toContain("primary/model");
    expect(String((err as Error).message)).toMatch(/then fallback fallback\/model/);
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(DOMException);
    // Primary: 2 attempts, then fallback: 2 attempts — all consumed by the timeout.
    expect(calls()).toEqual(["primary/model", "primary/model", "fallback/model", "fallback/model"]);
  });

  it("arms a fallback attempt with the extended budget and the primary with the short leash", async () => {
    // Prove the per-attempt abort budget is selected BY MODEL: the primary is held to its short
    // `requestTimeoutMs`, the fallback earns the longer `fallbackRequestTimeoutMs`. Spy on
    // AbortSignal.timeout to read the exact budget baked into each attempt's signal (the abort
    // duration is otherwise opaque). The bug this fixes: a shared 300s budget killed every big-board
    // fallback attempt at the guillotine, so the rescue model could never rescue.
    const spy = vi.spyOn(AbortSignal, "timeout");
    try {
      const client = {
        // The budgets createOpenRouterClient stamps for attemptTimeoutSignal to read.
        perAttemptTimeoutMs: 300000,
        fallbackAttemptTimeoutMs: 900000,
        chat: {
          completions: {
            create: (body: { model: string }) =>
              // Primary always empty → exhausts its 3 attempts; the fallback then paints successfully.
              Promise.resolve({
                choices: [
                  {
                    message: {
                      content: body.model === "fallback/model" ? "<div>rescued</div>" : "",
                    },
                  },
                ],
              }),
          },
        },
      } as unknown as OpenAI;
      await expect(
        requestText(client, {
          ...base,
          model: "primary/model",
          fallback: "fallback/model",
        }),
      ).resolves.toContain("rescued");
      const budgets = spy.mock.calls.map((c) => c[0]);
      // Primary's 3 attempts armed at the short leash; the fallback attempt at the long one.
      expect(budgets.filter((b) => b === 300000)).toHaveLength(3);
      expect(budgets).toContain(900000);
      // The fallback is never armed with the short primary budget (the guillotine bug).
      expect(budgets.filter((b) => b === 900000).length).toBeGreaterThanOrEqual(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("classifies an SDK response-body-parse failure (raw SyntaxError) as transient and recovers (text)", async () => {
    // Regression (eval-run crash): a truncated/empty response body makes the SDK's own JSON.parse
    // throw a raw SyntaxError. It must be retried like a socket drop, not rethrown terminally.
    let calls = 0;
    const client = {
      chat: {
        completions: {
          create: () => {
            calls += 1;
            if (calls === 1) return Promise.reject(bodyParseError());
            return Promise.resolve({
              choices: [{ message: { content: "<div>ok</div>" } }],
              usage: { prompt_tokens: 10, completion_tokens: 40, total_tokens: 50 },
            });
          },
        },
      },
    } as unknown as OpenAI;
    const seen: LlmUsage[] = [];
    await expect(requestText(client, { ...base, onUsage: (u) => seen.push(u) })).resolves.toContain(
      "ok",
    );
    expect(calls).toBe(2);
    // The parse-failed attempt threw (no usage); the recovered attempt reports attempt 2 (intact).
    expect(seen.map((u) => u.attempt)).toEqual([2]);
  });

  it("engages the fallback model when the primary persistently fails to parse its body (text)", async () => {
    const { client, calls } = modelAwareClient({
      "primary/model": [bodyParseError()], // SyntaxError on every primary attempt
      "fallback/model": ["<div>fallback paint</div>"],
    });
    await expect(
      requestText(client, { ...base, model: "primary/model", fallback: "fallback/model" }),
    ).resolves.toContain("fallback paint");
    // Primary exhausts its 3 attempts on body-parse failures, then the fallback recovers.
    expect(calls()).toEqual(["primary/model", "primary/model", "primary/model", "fallback/model"]);
  });

  it("throws a legible body-parse error (SyntaxError as cause, not a bare SyntaxError) on full exhaustion (text)", async () => {
    const { client, calls } = modelAwareClient({
      "primary/model": [bodyParseError()],
      "fallback/model": [bodyParseError()],
    });
    const err = await requestText(client, {
      ...base,
      model: "primary/model",
      fallback: "fallback/model",
      maxAttempts: 2,
    }).catch((e: unknown) => e);
    // Not the bare SyntaxError — a clear, attributable message with the original as cause.
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).not.toBe("SyntaxError");
    expect(String((err as Error).message)).toMatch(/could not be parsed/);
    expect((err as { cause?: unknown }).cause).toBeInstanceOf(SyntaxError);
    // Primary: 2 attempts, then fallback: 2 attempts — all consumed by the body-parse failure.
    expect(calls()).toEqual(["primary/model", "primary/model", "fallback/model", "fallback/model"]);
  });

  it("does not retry a non-transient error (e.g. a 400)", async () => {
    let calls = 0;
    const client = {
      chat: {
        completions: {
          create: () => {
            calls += 1;
            return Promise.reject(new Error("400 invalid request"));
          },
        },
      },
    } as unknown as OpenAI;
    await expect(requestText(client, base)).rejects.toThrow(/invalid request/);
    expect(calls).toBe(1);
  });

  it("retries an empty completion within the attempt budget and recovers (paint empty-body)", async () => {
    let calls = 0;
    const client = {
      chat: {
        completions: {
          create: () => {
            calls += 1;
            // Empty twice (a reasoning model burning its budget), then real HTML on the third.
            return Promise.resolve({
              choices: [{ message: { content: calls < 3 ? "" : "<div>ok</div>" } }],
            });
          },
        },
      },
    } as unknown as OpenAI;
    await expect(requestText(client, base)).resolves.toContain("ok");
    expect(calls).toBe(3);
  });

  it("returns empty (painter then throws PaintError) once the budget is spent, honouring maxAttempts", async () => {
    let calls = 0;
    const client = {
      chat: {
        completions: {
          create: () => {
            calls += 1;
            return Promise.resolve({ choices: [{ message: { content: "" } }] });
          },
        },
      },
    } as unknown as OpenAI;
    await expect(requestText(client, { ...base, maxAttempts: 2 })).resolves.toBe("");
    expect(calls).toBe(2);
  });

  it("retries a truncated completion (finish_reason 'length') and recovers, reporting both attempts", async () => {
    let calls = 0;
    const client = {
      chat: {
        completions: {
          create: () => {
            calls += 1;
            // Attempt 1: a NON-EMPTY but truncated stub — the provider cut the completion at the
            // token cap (finish_reason "length"), so it would ship as a blank board if returned.
            // Attempt 2: a clean, complete body (finish_reason "stop").
            return Promise.resolve({
              choices: [
                calls === 1
                  ? { message: { content: "<div>trunc" }, finish_reason: "length" }
                  : { message: { content: "<div>ok</div>" }, finish_reason: "stop" },
              ],
              usage: {
                prompt_tokens: 10,
                completion_tokens: calls === 1 ? 32000 : 40,
                total_tokens: calls === 1 ? 32010 : 50,
              },
            });
          },
        },
      },
    } as unknown as OpenAI;
    const seen: LlmUsage[] = [];
    await expect(requestText(client, { ...base, onUsage: (u) => seen.push(u) })).resolves.toBe(
      "<div>ok</div>",
    );
    expect(calls).toBe(2);
    // Both the truncated attempt and the recovered one report usage — the truncated attempt's
    // 32000-token spend is otherwise blind.
    expect(seen.map((u) => u.attempt)).toEqual([1, 2]);
  });

  it("engages the fallback model after the primary returns only empty bodies (empty paint fallback)", async () => {
    const { client, calls } = modelAwareClient({
      "primary/model": [""], // always empty → exhausts its 3 attempts
      "fallback/model": ["<div>rich fallback paint</div>"],
    });
    await expect(
      requestText(client, { ...base, model: "primary/model", fallback: "fallback/model" }),
    ).resolves.toContain("rich fallback paint");
    expect(calls()).toEqual(["primary/model", "primary/model", "primary/model", "fallback/model"]);
  });

  it("falls back after the primary exhausts transient network drops, and can still recover", async () => {
    const { client, calls } = modelAwareClient({
      "primary/model": [socketDrop(), socketDrop(), socketDrop()],
      "fallback/model": ["<div>ok</div>"],
    });
    await expect(
      requestText(client, { ...base, model: "primary/model", fallback: "fallback/model" }),
    ).resolves.toContain("ok");
    expect(calls()).toEqual(["primary/model", "primary/model", "primary/model", "fallback/model"]);
  });

  it("merges session_id and trace into the request body when provided (Broadcast)", async () => {
    const { client, body } = capturingClient("<div>ok</div>");
    await requestText(client, {
      ...base,
      sessionId: "menu:screen-1:run-abc",
      trace: { trace_id: "run-abc", role: "paint" },
    });
    expect(body()["session_id"]).toBe("menu:screen-1:run-abc");
    expect(body()["trace"]).toEqual({
      trace_id: "run-abc",
      role: "paint",
      attempt: 1,
      max_attempts: 3,
    });
  });

  it("maps the reasoning setting into the request body (effort passthrough)", async () => {
    const { client, body } = capturingClient("<div>ok</div>");
    await requestText(client, { ...base, reasoning: { effort: "low" } });
    expect(body()["reasoning"]).toEqual({ effort: "low" });
  });

  it("fires onUsage for every attempt that produced a response, incl. an empty-body reasoning burn", async () => {
    let calls = 0;
    const client = {
      chat: {
        completions: {
          create: () => {
            calls += 1;
            const content = calls === 1 ? "" : "<div>ok</div>";
            // Attempt 1 spends a big completion budget on reasoning then returns empty — the exact
            // hidden double-spend this telemetry surfaces.
            return Promise.resolve({
              choices: [{ message: { content } }],
              usage: {
                prompt_tokens: 10,
                completion_tokens: calls === 1 ? 200 : 40,
                total_tokens: calls === 1 ? 210 : 50,
              },
            });
          },
        },
      },
    } as unknown as OpenAI;
    const seen: LlmUsage[] = [];
    await expect(requestText(client, { ...base, onUsage: (u) => seen.push(u) })).resolves.toContain(
      "ok",
    );
    expect(seen).toEqual([
      { promptTokens: 10, completionTokens: 200, totalTokens: 210, attempt: 1 },
      { promptTokens: 10, completionTokens: 40, totalTokens: 50, attempt: 2 },
    ]);
  });

  it("stamps each attempt with attempt number, budget, and prev_outcome (Braintrust)", async () => {
    const traces: unknown[] = [];
    let calls = 0;
    const client = {
      chat: {
        completions: {
          create: (body: Record<string, unknown>) => {
            traces.push(body["trace"]);
            calls += 1;
            // Mirror the real screen-3 failure shape: transient drop, then empty body, then success.
            if (calls === 1) {
              return Promise.reject(
                Object.assign(new Error("terminated"), { code: "UND_ERR_SOCKET" }),
              );
            }
            if (calls === 2) {
              return Promise.resolve({ choices: [{ message: { content: "" } }] });
            }
            return Promise.resolve({ choices: [{ message: { content: "<div>ok</div>" } }] });
          },
        },
      },
    } as unknown as OpenAI;
    await expect(
      requestText(client, { ...base, trace: { trace_id: "run-abc", role: "paint" } }),
    ).resolves.toContain("ok");
    expect(traces).toEqual([
      { trace_id: "run-abc", role: "paint", attempt: 1, max_attempts: 3 },
      {
        trace_id: "run-abc",
        role: "paint",
        attempt: 2,
        max_attempts: 3,
        prev_outcome: "transient_network",
      },
      {
        trace_id: "run-abc",
        role: "paint",
        attempt: 3,
        max_attempts: 3,
        prev_outcome: "empty_body",
      },
    ]);
  });
});
