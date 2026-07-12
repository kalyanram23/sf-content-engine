import { describe, expect, it } from "vitest";

import type { CanonicalItem, PlanScreen } from "../domain/types";
import { dhabaVocabulary } from "../vocabularies/dhaba/index";
import { buildComposerContent } from "./digest";

const items: CanonicalItem[] = [
  {
    id: "a1",
    name: "Aloo Tikki",
    category: "Snacks",
    available: true,
    price: 6,
    images: ["data:x"],
  },
  { id: "a2", name: "Samosa", category: "Snacks", available: true, price: 5, images: ["data:x"] },
  {
    id: "b1",
    name: "Gulab Jamun",
    category: "Sweets",
    available: true,
    price: 4,
    images: ["data:x"],
  },
  { id: "b2", name: "Barfi", category: "Sweets", available: true, price: 4 }, // no photo
  { id: "c1", name: "Chai", category: "Drinks", available: true, price: 3, images: ["data:x"] },
];

/** A board carrying BOTH a board-level shared slot AND per-section slots (exercises the union +
 * de-dupe rule; coverage never emits both, but a hand-authored plan can). `a1` is in both the
 * board-level slot and the Snacks slot → board-level wins (untagged). `b2` has no photo → excluded. */
const planScreen: PlanScreen = {
  id: "screen-1",
  imageSlot: { items: ["a1", "c1"] },
  sections: [
    {
      title: "Snacks",
      representation: "list",
      items: ["a1", "a2"],
      imageSlot: { kind: "photos", items: ["a1", "a2"] },
    },
    {
      title: "Sweets",
      representation: "list",
      items: ["b1", "b2"],
      imageSlot: { kind: "photos", items: ["b1", "b2"] },
    },
    { title: "Drinks", representation: "list", items: ["c1"] }, // no imageSlot
  ],
};

describe("buildComposerContent — photo candidates (per-section slot union)", () => {
  const { photoCandidates } = buildComposerContent({ planScreen, items, vocab: dhabaVocabulary });
  const byId = new Map(photoCandidates.map((c) => [c.id, c]));

  it("unions the board-level slot AND every per-section slot ∩ items-with-photos", () => {
    expect(new Set(photoCandidates.map((c) => c.id))).toEqual(new Set(["a1", "c1", "a2", "b1"]));
  });

  it("excludes a slot item that carries no photo (b2)", () => {
    expect(byId.has("b2")).toBe(false);
  });

  it("leaves board-level slot items UNTAGGED (band root's shared marker satisfies them)", () => {
    expect(byId.get("c1")?.slot).toBeUndefined();
  });

  it("tags a per-section-only item with its section title (the marker checkImageSlots keys on)", () => {
    expect(byId.get("a2")?.slot).toBe("Snacks");
    expect(byId.get("b1")?.slot).toBe("Sweets");
  });

  it("de-dupes an item in both slots: board-level wins (a1 kept once, untagged)", () => {
    expect(photoCandidates.filter((c) => c.id === "a1")).toHaveLength(1);
    expect(byId.get("a1")?.slot).toBeUndefined();
  });
});

describe("buildComposerContent — a comfortable board (per-section slots only)", () => {
  const comfortable: PlanScreen = {
    id: "screen-2",
    sections: [
      {
        title: "Snacks",
        representation: "list",
        items: ["a1", "a2"],
        imageSlot: { kind: "photos", items: ["a1", "a2"] },
      },
      {
        title: "Sweets",
        representation: "list",
        items: ["b1"],
        imageSlot: { kind: "photos", items: ["b1"] },
      },
    ],
  };

  it("yields a non-empty photo library keyed to each section slot", () => {
    const { photoCandidates } = buildComposerContent({
      planScreen: comfortable,
      items,
      vocab: dhabaVocabulary,
    });
    expect(photoCandidates.map((c) => c.id)).toEqual(["a1", "a2", "b1"]);
    expect(photoCandidates.map((c) => c.slot)).toEqual(["Snacks", "Snacks", "Sweets"]);
  });
});
