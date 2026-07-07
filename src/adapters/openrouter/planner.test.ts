import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import type { PlanLayout } from "../../domain/contracts";
import type { CanonicalItem, GenerateInput } from "../../domain/types";
import type { UsageEvent, UsageSink } from "../../ports/services";
import { OpenRouterPlanner, SYSTEM } from "./planner";

/** A fake OpenAI client whose completion returns `content` verbatim (hermetic — no network). */
function mockClient(content: string): { client: OpenAI; create: ReturnType<typeof vi.fn> } {
  const create = vi.fn().mockResolvedValue({ choices: [{ message: { content } }] });
  return { client: { chat: { completions: { create } } } as unknown as OpenAI, create };
}

function item(id: string, name: string, category: string): CanonicalItem {
  return { id, name, category, available: true };
}

const ITEMS: CanonicalItem[] = [
  item("b1", "Chicken Biryani", "Biryani"),
  item("b2", "Paneer Biryani", "Biryani"),
  item("p1", "Chicken Pulav", "Pulav"),
  item("v1", "Mix Veg Curry", "Veg Curries"),
  item("d1", "Gulab Jamun", "Desserts"),
];

function input(screens: number | "auto"): GenerateInput {
  return {
    items: ITEMS,
    brief: { presetId: "bubblegum" },
    constraints: { aspect: "16:9", screens, locale: "en-US", currency: "USD" },
  };
}

const LAYOUT: PlanLayout = {
  blocks: [
    {
      title: "Biryani & Pulav",
      categories: ["Biryani", "Pulav"],
      representation: "matrix",
      layoutHint: "price table",
    },
    { title: "Veg Curries", categories: ["Veg Curries"], representation: "grid", layoutHint: "" },
    // "Desserts" omitted on purpose — the expander must still cover it.
  ],
};

describe("OpenRouterPlanner", () => {
  it("expands the LLM layout into a coverage-guaranteed ThinPlan (screen count flexes to fit)", async () => {
    const { client } = mockClient(JSON.stringify(LAYOUT));
    const plan = await new OpenRouterPlanner(client, "test-model").plan(input(2));

    // The requested count is a HINT (§ Phase 3): a 5-item menu fits fewer boards than requested.
    // The invariant is COVERAGE — every item lands somewhere — not an exact board count.
    expect(plan.screens.length).toBeGreaterThanOrEqual(1);
    const placed = plan.screens.flatMap((s) => s.sections.flatMap((sec) => sec.items));
    expect(new Set(placed)).toEqual(new Set(ITEMS.map((i) => i.id)));

    const combined = plan.screens
      .flatMap((s) => s.sections)
      .find((sec) => sec.title === "Biryani & Pulav");
    expect(combined?.representation).toBe("matrix");
    expect(combined?.layoutHint).toBe("price table");
  });

  it("sends the menu digest + target screen count, and the user steering note, to the model", async () => {
    const { client, create } = mockClient(JSON.stringify(LAYOUT));
    const withNote: GenerateInput = {
      ...input(2),
      brief: { presetId: "bubblegum", notes: "combine biryani and pulav as a price table" },
    };
    await new OpenRouterPlanner(client, "test-model").plan(withNote);

    const body = create.mock.calls[0]![0] as { messages: { role: string; content: string }[] };
    const user = body.messages.find((m) => m.role === "user")!.content;
    expect(user).toContain("Target screens: 2");
    expect(user).toContain("Biryani");
    expect(user).toContain("combine biryani and pulav");
  });

  it("honours screensMode 'exact': the requested count is law (capped only by sections, D26)", async () => {
    const { client } = mockClient(JSON.stringify(LAYOUT));
    const planner = new OpenRouterPlanner(client, "test-model", undefined, undefined, undefined, {
      legibilityBudget: 24,
      minItemsPerBoard: 4,
      screensMode: "exact",
    });
    // 5 items over 2 boards is "sparse" — elastic would lower to 1; exact keeps 2 (3 sections ≥ 2).
    const plan = await planner.plan(input(2));
    expect(plan.screens).toHaveLength(2);
    const placed = plan.screens.flatMap((s) => s.sections.flatMap((sec) => sec.items));
    expect(new Set(placed)).toEqual(new Set(ITEMS.map((i) => i.id)));
  });

  it("resolves 'auto' screens from item count", async () => {
    const { client, create } = mockClient(JSON.stringify(LAYOUT));
    await new OpenRouterPlanner(client, "test-model").plan(input("auto"));
    const body = create.mock.calls[0]![0] as { messages: { role: string; content: string }[] };
    const user = body.messages.find((m) => m.role === "user")!.content;
    // 5 items / budget 24-per-board → 1 screen hint
    expect(user).toContain("Target screens: 1");
  });

  it("records structured token usage to the UsageSink when wired (role + model + counts, D28)", async () => {
    // OpenRouter returns usage on every response; the adapter fans it out to the UsageSink AND the
    // debug log (both fire). Hermetic — the mock client supplies the usage block.
    const create = vi.fn().mockResolvedValue({
      choices: [{ message: { content: JSON.stringify(LAYOUT) } }],
      usage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        prompt_tokens_details: { cached_tokens: 20 },
      },
    });
    const client = { chat: { completions: { create } } } as unknown as OpenAI;
    const events: UsageEvent[] = [];
    const usage: UsageSink = {
      record: (event) => {
        events.push(event);
      },
    };
    // usage is the 8th constructor arg (after logger/reasoning/maxTokens/planning/resilience).
    await new OpenRouterPlanner(
      client,
      "test-model",
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      usage,
    ).plan(input(2));

    expect(events).toEqual([
      {
        role: "plan",
        model: "test-model",
        promptTokens: 100,
        completionTokens: 50,
        totalTokens: 150,
        cachedTokens: 20,
        attempt: 1,
        fallback: false,
      },
    ]);
  });
});

/**
 * The planner-facing representation enum (E1): "variant-rows" is dropped because the id-free menu
 * digest carries no variant signal, so offering it would invite uninformed guessing. (The internal
 * enum keeps it for `checkRepresentations` + hand-authored plans.)
 */
describe("planner SYSTEM prompt", () => {
  it("no longer offers the undefined 'variant-rows' representation", () => {
    expect(SYSTEM).not.toContain("variant-rows");
  });

  it("still offers matrix, grid, and list", () => {
    expect(SYSTEM).toContain('"matrix", "grid", "list"');
  });
});
