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
});
