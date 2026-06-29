import type OpenAI from "openai";
import { describe, expect, it, vi } from "vitest";

import type { PlanLayout } from "../../domain/contracts";
import type { CanonicalItem, GenerateInput } from "../../domain/types";
import { OpenRouterPlanner } from "./planner";

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
  it("turns the LLM layout into a coverage-guaranteed ThinPlan of the requested screen count", async () => {
    const { client } = mockClient(JSON.stringify(LAYOUT));
    const plan = await new OpenRouterPlanner(client, "test-model").plan(input(2));

    expect(plan.screens).toHaveLength(2);
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

  it("resolves 'auto' screens from item count", async () => {
    const { client, create } = mockClient(JSON.stringify(LAYOUT));
    await new OpenRouterPlanner(client, "test-model").plan(input("auto"));
    const body = create.mock.calls[0]![0] as { messages: { role: string; content: string }[] };
    const user = body.messages.find((m) => m.role === "user")!.content;
    // 5 items / 40-per-screen → 1 screen
    expect(user).toContain("Target screens: 1");
  });
});
