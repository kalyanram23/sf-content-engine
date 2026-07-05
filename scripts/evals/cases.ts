/**
 * The eval suite definition — a FROZEN list of scenarios. Each case is one realistic job the
 * engine must do well, chosen to probe a distinct failure mode. Add cases; avoid editing
 * existing ones (that would make runs incomparable). See scripts/evals/README.md.
 */
import type { CanonicalItem } from "../../src/index";
import {
  dessertsAndDrinksMenu,
  fullMenu,
  longTextMenu,
  photoHeavyMenu,
  sparseMenu,
  textOnlyMenu,
  tinyMenu,
} from "./menus";

export interface EvalCase {
  /** Stable id — doubles as the output folder name. */
  id: string;
  /** Plain-language: what this scenario probes. */
  what: string;
  menu: () => CanonicalItem[];
  /** Theme preset id (themes/<id>.theme.json). */
  presetId: string;
  /** Requested board count (exact mode: capped only by the category count). */
  screens: number;
  aspect: "16:9" | "9:16";
  /** Restaurant name shown on boards + used in observability trace ids. */
  restaurant: string;
  /**
   * In the `--smoke` iteration tier? The smoke set is the cheapest handful that still covers the
   * distinct failure classes: smallest menu / price-table handling (`tiny-menu`), dead-space fill
   * on a near-empty board (`sparse-board`), and the portrait 9:16 composition problem child
   * (`portrait`). The photo-heavy / text-only / long-text / full-menu cases stay full-suite-only
   * (full-menu alone is 6 boards).
   */
  smoke?: boolean;
}

export const evalCases: EvalCase[] = [
  {
    id: "tiny-menu",
    what: "Smallest realistic menu (5 items with sizes/variants) — price-table handling",
    menu: tinyMenu,
    presetId: "bubblegum",
    screens: 1,
    aspect: "16:9",
    restaurant: "Slice & Spice",
    smoke: true,
  },
  {
    id: "sparse-board",
    what: "Three items on one board — can it fill a screen without looking empty?",
    menu: sparseMenu,
    presetId: "botanical",
    screens: 1,
    aspect: "16:9",
    restaurant: "Third Rail Coffee",
    smoke: true,
  },
  {
    id: "photo-heavy",
    what: "~28 items, most with photos — image layout, cropping, and loading",
    menu: photoHeavyMenu,
    presetId: "bubblegum",
    screens: 2,
    aspect: "16:9",
    restaurant: "Bombay Street Kitchen",
  },
  {
    id: "text-only",
    what: "~26 items, zero photos — the board must carry itself on typography",
    menu: textOnlyMenu,
    presetId: "blockframe",
    screens: 2,
    aspect: "16:9",
    restaurant: "Dosa Junction",
  },
  {
    id: "portrait",
    what: "Vertical 9:16 screens (~38 desserts + drinks) — portrait layout",
    menu: dessertsAndDrinksMenu,
    presetId: "bold-poster",
    screens: 2,
    aspect: "9:16",
    restaurant: "Sugar & Steam",
    smoke: true,
  },
  {
    id: "long-text",
    what: "Eight dishes with very long names/descriptions — overflow stress test",
    menu: longTextMenu,
    presetId: "botanical",
    screens: 1,
    aspect: "16:9",
    restaurant: "The Long Table",
  },
  {
    id: "full-menu",
    what: "The real job: all 241 items / 31 categories across 6 boards",
    menu: fullMenu,
    presetId: "blockframe",
    screens: 6,
    aspect: "16:9",
    restaurant: "Godavari Grand",
  },
];
