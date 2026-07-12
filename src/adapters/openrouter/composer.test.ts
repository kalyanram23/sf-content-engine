import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import type { CompositionResponse } from "../../domain/contracts";
import type { ComposeRequest } from "../../ports/composer";
import type { UsageEvent, UsageSink } from "../../ports/services";
import { OpenRouterComposer } from "./composer";

/** A fake OpenAI client whose completion returns `content` verbatim (hermetic — no network). */
function mockClient(content: string): { client: OpenAI; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockResolvedValue({ choices: [{ message: { content } }] });
  return { client: { chat: { completions: { create } } } as unknown as OpenAI, create };
}

const CANVAS = { width: 1920, height: 1080 };

function composeRequest(overrides?: Partial<ComposeRequest>): ComposeRequest {
  return {
    digest:
      'BOARD CONTENT — render every section below exactly once:\nSection "Biryani" (3): Chicken Biryani $12.00; Paneer Biryani $11.00; Egg Biryani $10.00\n\nPHOTO LIBRARY — the only ids you may put in a collage:\n  b1 = Chicken Biryani',
    vocabularyPrompt:
      'Block vocabulary (each block\'s "kind" + the ONE field it uses):\n- "section" → { "kind":"section", "section":"<exact section title>" } — one numbered section.',
    canvas: CANVAS,
    ...overrides,
  };
}

/** A schema-valid composition (all four block fields present — strict-mode shape). */
const COMPOSITION: CompositionResponse = {
  title: "Rice & Curry Feast",
  blocks: [
    { kind: "section", section: "Biryani", sections: [], itemIds: [] },
    { kind: "group", section: "", sections: ["Pulav", "Mandi"], itemIds: [] },
    { kind: "photoBand", section: "", sections: [], itemIds: ["b1", "b2", "b3"] },
  ],
};

describe("OpenRouterComposer", () => {
  it("sends a strict json_schema whose root object has title + blocks", async () => {
    const { client, create } = mockClient(JSON.stringify(COMPOSITION));
    await new OpenRouterComposer(client, "test-model").compose(composeRequest());

    const body = create.mock.calls[0]![0] as {
      response_format: {
        type: string;
        json_schema: {
          name: string;
          strict: boolean;
          schema: { type: string; properties: Record<string, unknown> };
        };
      };
    };
    const rf = body.response_format;
    expect(rf.type).toBe("json_schema");
    expect(rf.json_schema.name).toBe("composition");
    expect(rf.json_schema.strict).toBe(true);
    expect(rf.json_schema.schema.type).toBe("object");
    expect(Object.keys(rf.json_schema.schema.properties)).toEqual(
      expect.arrayContaining(["title", "blocks"]),
    );
  });

  it("parses a valid response into a CompositionResponse", async () => {
    const { client } = mockClient(JSON.stringify(COMPOSITION));
    const comp = await new OpenRouterComposer(client, "test-model").compose(composeRequest());

    expect(comp.title).toBe("Rice & Curry Feast");
    expect(comp.blocks).toHaveLength(3);
    expect(comp.blocks[0]).toEqual({
      kind: "section",
      section: "Biryani",
      sections: [],
      itemIds: [],
    });
  });

  it("carries the canvas dims + orientation + vocabulary prompt (system) and the digest (user)", async () => {
    const { client, create } = mockClient(JSON.stringify(COMPOSITION));
    await new OpenRouterComposer(client, "test-model").compose(
      composeRequest({ digest: "DIGEST-MARKER", vocabularyPrompt: "VOCAB-MARKER" }),
    );

    const body = create.mock.calls[0]![0] as { messages: { role: string; content: string }[] };
    const system = body.messages.find((m) => m.role === "system")!.content;
    const user = body.messages.find((m) => m.role === "user")!.content;
    expect(system).toContain("1920×1080");
    expect(system).toContain("landscape");
    expect(system).toContain("VOCAB-MARKER");
    expect(user).toBe("DIGEST-MARKER");
  });

  it("reads orientation from the canvas: a tall canvas is 'portrait'", async () => {
    const { client, create } = mockClient(JSON.stringify(COMPOSITION));
    await new OpenRouterComposer(client, "test-model").compose(
      composeRequest({ canvas: { width: 1080, height: 1920 } }),
    );

    const body = create.mock.calls[0]![0] as { messages: { role: string; content: string }[] };
    const system = body.messages.find((m) => m.role === "system")!.content;
    expect(system).toContain("1080×1920");
    expect(system).toContain("portrait");
  });

  it("appends the QA findings note as a re-compose instruction on a re-compose", async () => {
    const { client, create } = mockClient(JSON.stringify(COMPOSITION));
    await new OpenRouterComposer(client, "test-model").compose(
      composeRequest({ digest: "DIGEST", findingsNote: "- photo band overflows the canvas" }),
    );

    const body = create.mock.calls[0]![0] as { messages: { role: string; content: string }[] };
    const user = body.messages.find((m) => m.role === "user")!.content;
    expect(user).toContain("DIGEST");
    expect(user).toContain("photo band overflows the canvas");
    expect(user.toLowerCase()).toContain("corrected composition");
  });

  it("re-asks exactly once with the validation error when the first response fails the schema", async () => {
    // invalid-then-valid: the first body is valid JSON but violates the schema (empty title,
    // non-array blocks) → the shared client re-asks once with the schema error appended, then parses.
    const create = vi
      .fn()
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify({ title: "", blocks: "nope" }) } }],
      })
      .mockResolvedValueOnce({
        choices: [{ message: { content: JSON.stringify(COMPOSITION) } }],
      });
    const client = { chat: { completions: { create } } } as unknown as OpenAI;

    const comp = await new OpenRouterComposer(client, "test-model").compose(composeRequest());

    expect(create).toHaveBeenCalledTimes(2);
    const second = create.mock.calls[1]![0] as { messages: { role: string; content: string }[] };
    expect(
      second.messages.some((m) => m.role === "user" && /did not match the schema/i.test(m.content)),
    ).toBe(true);
    expect(comp.title).toBe("Rice & Curry Feast");
  });

  it("flows request correlation through as OpenRouter session_id + trace (role compose)", async () => {
    const { client, create } = mockClient(JSON.stringify(COMPOSITION));
    await new OpenRouterComposer(client, "test-model").compose(
      composeRequest({
        correlation: {
          runId: "run-7",
          restaurant: "Spice Route",
          screenId: "screen-2",
          iteration: 1,
        },
      }),
    );

    const body = create.mock.calls[0]![0] as {
      session_id?: string;
      trace?: Record<string, unknown>;
    };
    expect(body.session_id).toBe("spice-route:screen-2:run-7");
    expect(body.trace).toMatchObject({ role: "compose", trace_id: "run-7", board: "screen-2" });
  });

  it("records a usage event with role compose when a UsageSink is wired (D28)", async () => {
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(COMPOSITION) } }],
      usage: {
        prompt_tokens: 80,
        completion_tokens: 40,
        total_tokens: 120,
        prompt_tokens_details: { cached_tokens: 10 },
      },
    });
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const events: UsageEvent[] = [];
    const usage: UsageSink = {
      record: (event) => {
        events.push(event);
      },
    };
    // usage is the last constructor arg (client, model, logger, reasoning, maxTokens, resilience, usage).
    await new OpenRouterComposer(
      client,
      "test-model",
      undefined,
      undefined,
      undefined,
      undefined,
      usage,
    ).compose(composeRequest());

    expect(events).toEqual([
      {
        role: "compose",
        model: "test-model",
        promptTokens: 80,
        completionTokens: 40,
        totalTokens: 120,
        cachedTokens: 10,
        attempt: 1,
        fallback: false,
      },
    ]);
  });
});
