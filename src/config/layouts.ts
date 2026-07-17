import { z } from "zod";

import { layoutBlueprintSchema } from "../domain/schemas";
import type { LayoutBlueprint } from "../domain/types";
import { MATRIX_FIRST_STRATEGY, PHOTO_LED_GRID_STRATEGY } from "../planning/layout-strategy";
import { deepFreeze } from "../util/freeze";

/**
 * The named layout-blueprint catalog (D17) — hyperframes' "frame treatments" adapted to
 * static signage. Replaces the hardcoded matrix-vs-photo binary with data: each blueprint is
 * selection rules + strategy prose + a FIXED/FREE contract. The two seed blueprints reproduce
 * the legacy branch VERBATIM (regression-pinned by tests); the rest apply only in their
 * niches, so a board that fits none behaves exactly as before. Themes may override/extend by
 * id via `themePreset.layouts`. Adding a layout is a data edit, never an engine change.
 */

/**
 * The FIXED DOM shape of the base-dish comparison table (§ Phase 2). Theme-agnostic — no colour
 * or size classes (those stay the painter's job), only the `data-*` attributes the matrix-structure
 * check + runtime patcher require. The header row is `data-matrix-head` (NOT a `data-matrix-row`),
 * so it is not counted as a data row.
 */
const MATRIX_SKELETON = `<div data-matrix>
  <div data-matrix-head>
    <div><!-- row-label column (blank) --></div>
    <div>Biryani</div>
    <div>Pulav</div>
  </div>
  <!-- ONE data-matrix-row per base dish; its value is the row label -->
  <div data-matrix-row="Chicken Dum">
    <div><span data-bind="name">Chicken Dum</span></div>
    <!-- a FILLED cell: the item's id + availability + EXACTLY ONE price span tagged with the column -->
    <div data-matrix-cell="Biryani" data-item-id="ITEM_ID" data-available="true">
      <span data-bind="price" data-size="Biryani">$0.00</span>
    </div>
    <!-- an EMPTY cell: an em-dash, NO price span -->
    <div data-matrix-cell="Pulav">—</div>
  </div>
</div>`;

const DEFAULT_BLUEPRINTS: LayoutBlueprint[] = [
  // Seed 1/2 — the legacy matrix branch, verbatim.
  {
    id: "matrix-first",
    priority: 100,
    appliesWhen: { representationAnyOf: ["matrix"], layoutHintPattern: "matrix|table" },
    strategy: MATRIX_FIRST_STRATEGY,
    fixed: [
      "The price table is the primary layout — one price cell per row×column intersection",
      "ONE shared rotating hero for the whole board, never per-section heroes — roughly 12–15% of " +
        "the canvas area (about a quarter of the board width, or a full-width band roughly a fifth " +
        "of the height on portrait), aspect between 4:3 and 2:1; never a >3:1 sliver, never a " +
        "corner thumbnail",
    ],
    free: ["Table styling and column emphasis", "Where the shared hero sits"],
    // Theme-agnostic DOM shape for the base-dish price table (§ Phase 2). NO colour/size classes —
    // those are the painter's job; only the data-* attributes the checks + patcher require are
    // fixed. Filled from the MATRIX DATA handed alongside it: one row per base dish, one cell per
    // column, exactly one price span in a filled cell, an em-dash and NO price span in an empty one.
    skeleton: MATRIX_SKELETON,
  },
  // A tiny photo board reads best as one dominant hero + feature cards.
  {
    id: "hero-split",
    priority: 60,
    appliesWhen: { representationAnyOf: ["grid"], maxItems: 4, minPhotoItems: 1 },
    strategy:
      "LAYOUT STRATEGY for this board: HERO SPLIT. Make one item (the most photogenic) a dominant hero " +
      "filling roughly half the canvas — a real fraction, never a corner thumbnail — built as the CAROUSEL " +
      "above when it has 2+ photos. The remaining items sit as generous feature cards beside or below it.",
    fixed: [
      "Exactly one dominant hero on the board",
      "Every planned item still individually rendered as its own card",
    ],
    free: ["Which item is the hero", "Side-by-side vs stacked split", "Feature-card order"],
  },
  // Multi-section mid-size boards: one dominant feature column + a compact rail.
  {
    id: "feature-sidebar",
    priority: 50,
    appliesWhen: { minSections: 2, maxSections: 3, minItems: 5, maxItems: 12 },
    strategy:
      "LAYOUT STRATEGY for this board: FEATURE + SIDEBAR. The largest section is the feature column — " +
      "photo-led, large cards, its own rotating hero where photos allow. The remaining smaller sections " +
      "form a compact sidebar rail of type-led rows (tighter, but never below the type-size minimums).",
    fixed: [
      "One clearly dominant feature column",
      "The sidebar stays type-led — no cramped thumbnail strips",
    ],
    free: ["Which side the rail sits on", "Feature card treatment and hero choice"],
  },
  // A photo-rich mid-size grid board: disciplined, uniform cards.
  {
    id: "three-up-grid",
    priority: 40,
    appliesWhen: { representationAnyOf: ["grid"], minItems: 5, maxItems: 12, minPhotoItems: 3 },
    strategy:
      "LAYOUT STRATEGY for this board: UNIFORM PHOTO GRID. A disciplined grid of equal-size photo cards " +
      "(three columns on a landscape canvas), each with the photo on top and the name + price block on a " +
      "solid surface below; the section header spans the full grid width.",
    fixed: [
      "Uniform card size across the grid",
      "Photo on the card top; name and price on a solid surface below it",
    ],
    free: ["Column count fitting the item count", "Header and divider treatment"],
  },
  // A long single list: a type-led price ladder, not a photo wall.
  {
    id: "price-ladder",
    priority: 30,
    appliesWhen: { representationAnyOf: ["list"], minItems: 9 },
    strategy:
      "LAYOUT STRATEGY for this board: PRICE LADDER. A type-led list — names and prices in aligned columns " +
      "joined by dotted leaders, split into two or three balanced columns. NO per-item photos; the only " +
      "imagery is the plan's ONE shared compact hero when the plan supplies one (else none).",
    fixed: [
      "No per-item photos — this board is type-led",
      "Prices aligned down a ladder with dotted leaders",
    ],
    free: ["Column count and balance", "Section separation treatment"],
  },
  // Seed 2/2 — the legacy photo-grid branch, verbatim; the catch-all.
  {
    id: "photo-led-grid",
    priority: 0,
    appliesWhen: {},
    strategy: PHOTO_LED_GRID_STRATEGY,
    fixed: ["Every item gets its own card", "Each photo section leads with its own rotating hero"],
    free: ["Grid geometry and card proportions", "Which item leads each section"],
  },
];

export const layoutsConfigSchema = z.object({
  blueprints: z.array(layoutBlueprintSchema).default(DEFAULT_BLUEPRINTS),
});

export type LayoutsConfig = z.infer<typeof layoutsConfigSchema>;

export const defaultLayoutsConfig = (): LayoutsConfig => deepFreeze(layoutsConfigSchema.parse({}));
