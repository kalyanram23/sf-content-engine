/**
 * Eval menu builders. Every menu here is DETERMINISTIC — either a checked-in file or a fixed
 * slice/synthetic list — so an eval run always tests the same inputs and two runs are comparable.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import type { CanonicalItem } from "../../src/index";

function loadJsonMenu(relativePath: string): CanonicalItem[] {
  return JSON.parse(readFileSync(join(process.cwd(), relativePath), "utf8")) as CanonicalItem[];
}

/** The full 241-item real restaurant menu (31 categories, ~50 photo URLs). */
export function fullMenu(): CanonicalItem[] {
  return loadJsonMenu("samples/menu.json");
}

/** The 5-item starter menu (pizzas with sizes, sides, a curry with variants). */
export function tinyMenu(): CanonicalItem[] {
  return loadJsonMenu("scripts/my-menu.example.json");
}

/** A fixed slice of the full menu: only the given categories, original order preserved. */
export function menuSlice(categories: readonly string[]): CanonicalItem[] {
  const wanted = new Set(categories);
  return fullMenu().filter((item) => item.category !== undefined && wanted.has(item.category));
}

/** Photo-rich slice: ~28 items, ~18 of them with real photo URLs. */
export function photoHeavyMenu(): CanonicalItem[] {
  return menuSlice(["Frankies", "Sandwiches", "Chaat", "Falooda'S", "Indo Chinese"]);
}

/** Text-only slice: ~26 items, zero photos — the board must carry itself on typography. */
export function textOnlyMenu(): CanonicalItem[] {
  return menuSlice(["Dosa", "Special Rice", "Snack Box", "Momos", "Quick Bites"]);
}

/** Desserts + drinks slice (~38 items) used for the portrait-orientation case. */
export function dessertsAndDrinksMenu(): CanonicalItem[] {
  return menuSlice(["Desserts", "Hot Drinks", "Cold Drinks / Beverages"]);
}

/** Three items, one category — a nearly-empty board (known hard case for the density check). */
export function sparseMenu(): CanonicalItem[] {
  return [
    {
      id: "espresso",
      name: "Espresso",
      category: "Coffee",
      price: 3.5,
      description: "Double shot, house blend",
      available: true,
    },
    {
      id: "cappuccino",
      name: "Cappuccino",
      category: "Coffee",
      price: 4.75,
      description: "Silky microfoam, cocoa dust",
      available: true,
    },
    {
      id: "affogato",
      name: "Affogato",
      category: "Coffee",
      price: 6.0,
      description: "Vanilla gelato drowned in a double espresso",
      available: true,
    },
  ];
}

/** Eight items with very long names and descriptions — an overflow / truncation stress test. */
export function longTextMenu(): CanonicalItem[] {
  const dishes: Array<[string, string, number]> = [
    [
      "Slow-Braised Heritage Pork Shoulder with Charred Sweetcorn Succotash and Smoked Paprika Jus",
      "Eight-hour braised free-range pork shoulder, finished over open flame, served on a bed of charred sweetcorn and butterbean succotash with pickled red onion, crispy sage, and a smoked paprika and cider reduction poured tableside.",
      24.5,
    ],
    [
      "Pan-Seared Day-Boat Scallops with Cauliflower Three Ways and Brown Butter Hazelnut Crumble",
      "Hand-dived scallops seared to a deep caramel crust, plated with cauliflower purée, pickled florets, and cauliflower couscous, then showered with a warm brown-butter hazelnut crumble and micro chervil.",
      28,
    ],
    [
      "Wild Mushroom and Truffle Pappardelle with Aged Parmesan Cream and Toasted Pine Nuts",
      "Fresh ribbons of egg pappardelle folded through a slow-reduced cream of porcini, chanterelle, and black trumpet mushrooms, lifted with white truffle oil, finished with twenty-four-month Parmesan and toasted pine nuts.",
      21,
    ],
    [
      "Twice-Cooked Crispy Duck Leg with Sour Cherry Gastrique and Celeriac-Potato Gratin",
      "Confit duck leg crisped to order, glazed in a sour cherry and star anise gastrique, alongside a seven-layer celeriac and potato gratin with Gruyère crust and a watercress and orange salad.",
      26.75,
    ],
    [
      "Charcoal-Grilled Aubergine Steak with Whipped Tahini, Pomegranate, and Za'atar Flatbread",
      "Thick-cut aubergine charred over binchotan, lacquered with date molasses, served on whipped lemon tahini with pomegranate seeds, pistachio dukkah, and a blistered za'atar flatbread straight from the oven.",
      18.5,
    ],
    [
      "Butter-Poached Lobster Tail Risotto with Saffron, Preserved Lemon, and Shellfish Bisque Foam",
      "Carnaroli rice slowly stirred in a shellfish stock with saffron threads and preserved lemon, crowned with a whole butter-poached lobster tail and an airy bisque foam, finished with chive oil.",
      34,
    ],
    [
      "Fourteen-Hour Smoked Beef Short Rib with Burnt-End Beans and Pickle-Brined Slaw",
      "Prime short rib smoked overnight on oak and cherry wood until it falls from the bone, brushed with an espresso barbecue glaze, served with molasses burnt-end beans and a crunchy pickle-brined cabbage slaw.",
      29.5,
    ],
    [
      "Valrhona Dark Chocolate Delice with Salted Caramel Core, Cocoa Nib Tuile, and Crème Fraîche",
      "A glossy seventy-percent Valrhona chocolate delice hiding a molten salted caramel core, plated with cocoa nib tuile shards, caramelized white chocolate soil, and a quenelle of cultured crème fraîche.",
      12.5,
    ],
  ];
  return dishes.map(([name, description, price], index) => ({
    id: `tasting-${index + 1}`,
    name,
    description,
    price,
    category: "Chef's Tasting",
    available: true,
  }));
}
