import type OpenAI from "openai";
import { describe, expect, it } from "vitest";
import { z } from "zod";

import { LlmContractError } from "../../domain/errors";
import { requestStructured, requestText, toStrictJsonSchema } from "./client";

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
