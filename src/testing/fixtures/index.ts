import { parseOrThrow } from "../../domain/parse";
import { generateInputSchema, thinPlanSchema } from "../../domain/schemas";
import type { CanonicalItem, GenerateInput, ThemeBrief, ThinPlan } from "../../domain/types";

/** A small deterministic menu exercising matrix (sizes), list (scalar price), and variant-rows. */
export const sampleMenu: CanonicalItem[] = [
  {
    id: "p-margherita",
    name: "Margherita",
    category: "pizzas",
    available: true,
    sizes: [
      { label: '8"', price: 8.99 },
      { label: '10"', price: 11.99 },
      { label: '12"', price: 13.99 },
    ],
    images: ["data:image/svg+xml,%3Csvg/%3E"],
  },
  {
    id: "p-pepperoni",
    name: "Pepperoni",
    category: "pizzas",
    available: true,
    sizes: [
      { label: '8"', price: 9.99 },
      { label: '10"', price: 12.99 },
      { label: '12"', price: 14.99 },
    ],
  },
  { id: "s-garlic-bread", name: "Garlic Bread", category: "sides", available: true, price: 5.5 },
  {
    id: "c-curry",
    name: "House Curry",
    category: "curries",
    available: true,
    variants: [
      { label: "Veg", price: 9 },
      { label: "Paneer", price: 11 },
      { label: "Chicken", price: 12 },
    ],
  },
];

export const samplePlan: ThinPlan = parseOrThrow(
  thinPlanSchema,
  {
    screens: [
      {
        id: "screen-1",
        imageSlot: { categoryId: "pizzas", items: ["p-margherita", "p-pepperoni"] },
        sections: [
          { title: "PIZZAS", representation: "matrix", items: ["p-margherita", "p-pepperoni"] },
          { title: "SIDES", representation: "list", items: ["s-garlic-bread"] },
          { title: "CURRIES", representation: "variant-rows", items: ["c-curry"] },
        ],
      },
    ],
  },
  "sample plan",
);

export const sampleBrief: ThemeBrief = { presetId: "botanical" };

/** A full, valid `generate()` input with the hand-authored plan inline (v1, §5.4). */
export const sampleInput: GenerateInput = parseOrThrow(
  generateInputSchema,
  {
    items: sampleMenu,
    brief: sampleBrief,
    constraints: { aspect: "16:9", screens: 1 },
    plan: samplePlan,
  },
  "sample input",
);

export const fixtures = {
  menu: sampleMenu,
  plan: samplePlan,
  brief: sampleBrief,
  input: sampleInput,
};
