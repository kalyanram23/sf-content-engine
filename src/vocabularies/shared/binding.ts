/**
 * Shared vocabulary toolbox — the engine-coupled binding/escaping mechanics every composition
 * vocabulary must get byte-exact. Theme modules built on this kit contain only visual decisions;
 * the invariants QA punishes silently live here, once:
 *
 *   - `esc` escapes `& < > "` — the SAME escape set as `escapeSlotTitle` in
 *     src/qa/structural-checks.ts. The emitter stamps `data-image-slot` markers and that QA
 *     matcher recomputes the expected value from the plan; any divergence false-fires
 *     `image-slot-missing` on titles carrying those characters.
 *   - `bindRow`/`bindPrice` stamp the §5.5 binding contract: `data-item-id` on each item row
 *     (binding-integrity) and `data-bind="price"` on the price element (price-present treats its
 *     non-whitespace text as "filled").
 *   - `imgPlaceholder` emits the src-less `<img data-img-item data-img-index>` the packager
 *     inlines to an offline data-URI (§5.1) — a vocabulary must never write a real `src`.
 *
 * NOTE (B-lite, D78): src/vocabularies/dhaba/ keeps its own private copies of these helpers ON
 * PURPOSE — it is the untouched reference implementation. binding.test.ts pins this kit's escaping
 * to dhaba's rendered output and to the QA matcher, so the copies cannot drift silently.
 */

import type { VocabItem } from "../../ports/vocabulary-registry";

/** Escape a string for use in HTML text or a double-quoted attribute (`& < > "`). */
export const esc = (s: string): string =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Display price: `$X.YY`, or "" for a null (market) price — themes render their own MP mark. */
export const money = (p: number | null): string => (p === null ? "" : `$${p.toFixed(2)}`);

/**
 * A ` data-image-slot="<slot>"` attribute (leading space) for a photo card satisfying a
 * PER-SECTION image slot, escaped exactly like the QA matcher expects. Empty string for a
 * board-level (shared) item — the band root's own `data-image-slot="shared"` covers those.
 */
export const cardSlotAttr = (c: VocabItem): string =>
  c.slot !== undefined ? ` data-image-slot="${esc(c.slot)}"` : "";

/**
 * One item row's binding root: a `<div data-item-id>` wrapping the theme's row markup. Every
 * rendered menu item must pass through this (or stamp the attribute itself) or binding-integrity
 * QA flags the board.
 */
export const bindRow = (item: Pick<VocabItem, "id">, style: string, inner: string): string =>
  `<div data-item-id="${item.id}" style="${style}">${inner}</div>`;

/** The price element carrying the engine's `data-bind="price"` marker; `text` must be non-empty. */
export const bindPrice = (text: string, style: string): string =>
  `<span data-bind="price" style="${style}">${text}</span>`;

/**
 * Price markup for an item: a single data-bind="price" span, or — for a sized item — one span per
 * size, each stamped `data-size="<label>"` (the serve-time patcher's per-size selector, spec §4).
 * Sizes win over a base price. Labels are escaped with the QA-exact `esc`.
 */
export const bindPrices = (item: Pick<VocabItem, "price" | "sizes">, style: string): string => {
  if (item.sizes !== undefined && item.sizes.length > 0) {
    return item.sizes
      .map(
        (s) =>
          `<span data-bind="price" data-size="${esc(s.label)}" style="${style}">` +
          `${esc(s.label)} ${money(s.price)}</span>`,
      )
      .join(`<span style="${style}" aria-hidden="true"> · </span>`);
  }
  return bindPrice(item.price === null ? "MP" : money(item.price), style);
};

/**
 * A src-less photo placeholder the packager inlines to the item's offline data-URI. `style` is the
 * theme's (object-fit etc.); the alt is the escaped item name.
 */
export const imgPlaceholder = (item: Pick<VocabItem, "id" | "name">, style: string): string =>
  `<img data-img-item="${item.id}" data-img-index="0" alt="${esc(item.name)}" style="${style}">`;

/**
 * The brand-logo placeholder (D18): the packager fills `<img data-brand-logo>` with the resolved
 * logo data-URI. `alt` should be the brand name when known.
 */
export const brandLogoPlaceholder = (alt: string, style: string): string =>
  `<img data-brand-logo alt="${esc(alt)}" style="${style}">`;
