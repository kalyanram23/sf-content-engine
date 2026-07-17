/**
 * B-lite sync pins (D78): the dhaba module keeps its own private copies of the binding/escaping
 * mechanics as the untouched reference implementation. These tests pin the shared toolbox to
 * (1) dhaba's observable escaping and (2) the QA matcher's recomputation, so the copies cannot
 * drift silently — a divergence fails HERE with a name, instead of a theme quietly failing QA.
 */

import { describe, expect, it } from "vitest";

import { defaultEngineConfig } from "../../config/index";
import { parseOrThrow } from "../../domain/parse";
import { planScreenSchema } from "../../domain/schemas";
import type { ResolvedTheme } from "../../domain/types";
import { checkImageSlots, type StructuralContext } from "../../qa/structural-checks";
import { botanicalPreset } from "../../theme/presets/index";
import { dhabaVocabulary } from "../dhaba/index";
import {
  bindName,
  bindPrice,
  bindPrices,
  bindRow,
  cardSlotAttr,
  esc,
  imgPlaceholder,
  money,
} from "./binding";

const SLOT = 'The "Big" & <Best> Board';

describe("shared binding toolbox — sync pins", () => {
  it("esc matches dhaba's rendered slot escaping byte-for-byte", () => {
    const html = dhabaVocabulary.renderPhotoBand({
      items: [{ id: "s0", name: 'The "Combo"', price: 9.99, hasImage: true, slot: SLOT }],
      register: "M",
      bandHeight: 300,
      bandWidth: 976,
      mode: "filmstrip",
      uid: "pin",
    });
    // dhaba's private esc and the toolbox esc must produce the same marker + alt bytes.
    expect(html).toContain(`data-image-slot="${esc(SLOT)}"`);
    expect(html).toContain(`alt="${esc('The "Combo"')}"`);
  });

  it("esc round-trips through the QA matcher (checkImageSlots recomputes the same escaping)", () => {
    const cfg = defaultEngineConfig();
    const theme: ResolvedTheme = { ...botanicalPreset, density: "balanced" };
    const planScreen = parseOrThrow(
      planScreenSchema,
      {
        id: "b1",
        sections: [
          {
            title: SLOT,
            representation: "list",
            items: ["i0"],
            imageSlot: { kind: "photos", items: ["i0"] },
          },
        ],
      },
      "sync-pin plan screen",
    );
    const ctx = (html: string): StructuralContext => ({
      html,
      planScreen,
      items: [{ id: "i0", name: "Dish", available: true, price: 9.5 }],
      theme,
      qa: cfg.qa,
      tokenLint: cfg.tokenLint,
    });
    // Marker emitted with the toolbox escaper → the matcher finds it (no findings).
    const escaped = `<div><div data-image-slot="${esc(SLOT)}"></div></div>`;
    expect(checkImageSlots(ctx(escaped))).toEqual([]);
    // The RAW title would break the attribute at its first quote → the matcher must miss it,
    // proving it recomputes with the same escape set rather than matching loosely.
    const raw = `<div><div data-image-slot="${SLOT}"></div></div>`;
    expect(checkImageSlots(ctx(raw)).map((f) => f.kind)).toContain("image-slot-missing");
  });

  it("helpers stamp the exact engine markers", () => {
    expect(money(12.5)).toBe("$12.50");
    expect(money(null)).toBe("");
    expect(bindRow({ id: "x1" }, "p:1", "IN")).toBe('<div data-item-id="x1" style="p:1">IN</div>');
    expect(bindPrice("MP", "s")).toBe('<span data-bind="price" style="s">MP</span>');
    expect(bindName('Chik "65"', "s")).toBe(
      '<span data-bind="name" style="s">Chik &quot;65&quot;</span>',
    );
    expect(imgPlaceholder({ id: "x1", name: 'A"B' }, "w:1")).toBe(
      '<img data-img-item="x1" data-img-index="0" alt="A&quot;B" style="w:1">',
    );
    expect(cardSlotAttr({ id: "x", name: "n", price: 1, hasImage: true, slot: SLOT })).toBe(
      ` data-image-slot="${esc(SLOT)}"`,
    );
    expect(cardSlotAttr({ id: "x", name: "n", price: 1, hasImage: true })).toBe("");
  });
});

describe("bindPrices", () => {
  it("renders a single tagged span for a flat-priced item", () => {
    const html = bindPrices({ price: 9.5 }, "color:var(--color-price)");
    expect(html).toBe('<span data-bind="price" style="color:var(--color-price)">$9.50</span>');
  });

  it("renders MP for a null price (market price)", () => {
    expect(bindPrices({ price: null }, "x")).toContain(">MP<");
  });

  it("renders one span per size, tagged data-size with QA-exact escaping", () => {
    const html = bindPrices(
      {
        price: null,
        sizes: [
          { label: 'Sm "cup"', price: 5 },
          { label: "Lg", price: 7.25 },
        ],
      },
      "s",
    );
    const spans = [...html.matchAll(/<span data-bind="price" data-size="([^"]*)"[^>]*>([^<]*)</g)];
    expect(spans.map((m) => m[1])).toEqual(["Sm &quot;cup&quot;", "Lg"]);
    expect(spans[0]![2]).toBe('Sm "cup" $5.00'.replace(/"/g, "&quot;"));
    expect(spans[1]![2]).toBe("Lg $7.25");
  });

  it("prefers sizes over a base price when both exist", () => {
    const html = bindPrices({ price: 4, sizes: [{ label: "S", price: 5 }] }, "s");
    expect(html).not.toContain(">$4.00<");
    expect(html).toContain('data-size="S"');
  });
});
