import { PaintError } from "../../domain/errors";
import type {
  BrandInput,
  CanonicalItem,
  PlanScreen,
  PlanSection,
  Representation,
} from "../../domain/types";
import type { PaintRequest, Painter } from "../../ports/painter";

export interface FakePainterOptions {
  /**
   * Board ids whose `paint()` rejects with a terminal {@link PaintError} — the "throw on board N"
   * affordance for the per-board bulkhead tests (D28). A real painter can't retry its way out of
   * these (the adapter's retries/fallbacks are already spent), so the failure reaches generate().
   */
  readonly failScreenIds?: readonly string[];
}

/**
 * A deterministic painter that emits genuinely valid, bindable HTML on the rails: token
 * utility classes (no raw hex/px), `data-item-id`/`data-bind` hooks, `data-motion` from the
 * vocabulary, no external refs, no navigation. Real structural QA runs against this output;
 * rendered issues (contrast/density) are simulated by the {@link ScriptedBrowser}.
 */
export class FakePainter implements Painter {
  constructor(private readonly options: FakePainterOptions = {}) {}

  paint(request: PaintRequest): Promise<string> {
    if (this.options.failScreenIds?.includes(request.planScreen.id)) {
      return Promise.reject(
        new PaintError(
          `fake painter forced terminal failure for board "${request.planScreen.id}".`,
        ),
      );
    }
    return Promise.resolve(renderScreen(request.planScreen, request.items, request.brand));
  }
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Attribute-safe escape (adds `"` to escapeHtml's set) — mirrors `esc` in
 * src/vocabularies/shared/binding.ts, the QA-exact set the `data-size` matcher expects. */
function esc(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}

function renderItem(item: CanonicalItem, representation: Representation): string {
  const head = `<h3 class="text-lg text-text">${escapeHtml(item.name)}</h3>`;
  let body = "";

  if (representation === "matrix" && item.sizes && item.sizes.length > 0) {
    const cells = item.sizes
      .map(
        (s) =>
          `<div class="cell flex gap-2"><span class="text-muted">${escapeHtml(s.label)}</span>` +
          `<span class="text-price" data-bind="price" data-size="${esc(s.label)}">${money(s.price)}</span></div>`,
      )
      .join("");
    body = `<div class="matrix grid gap-2">${cells}</div>`;
  } else if (representation === "variant-rows" && item.variants && item.variants.length > 0) {
    const rows = item.variants
      .map((v) => {
        const price =
          v.price !== undefined
            ? `<span class="text-price" data-bind="price">${money(v.price)}</span>`
            : "";
        return `<div class="row flex gap-2"><span class="text-text">${escapeHtml(v.label)}</span>${price}</div>`;
      })
      .join("");
    body = `<div class="variant-rows grid gap-1">${rows}</div>`;
  } else {
    // Mirror the real painter's price contract: emit a data-bind="price" span ONLY when the item
    // actually carries a price. Under zeroPriceRender:"hide" (D29) zero/missing prices are stripped
    // upstream, so a priceless item renders WITHOUT a price element (never $0.00) — and the
    // required-price-binding check exempts it, keeping the fake honest against real structural QA.
    const price =
      item.price ??
      item.sizes?.[0]?.price ??
      item.variants?.find((v) => v.price !== undefined)?.price;
    body =
      price !== undefined
        ? `<span class="text-price" data-bind="price">${money(price)}</span>`
        : "";
  }

  return (
    `<article class="menu-item rounded-md bg-surface p-3" data-item-id="${item.id}" ` +
    `data-available="${item.available}">${head}${body}</article>`
  );
}

/**
 * A per-category image slot (the category-images requirement): a `data-image-slot="<category>"`
 * container holding either a gallery-fade carousel of the category's photos (`kind: "photos"` — NO
 * src, the packager inlines from `data-img-item`) or a deliberate inline-SVG food-icon panel
 * (`kind: "icon"`, for a category whose items carry no photos). Token classes only, no external
 * refs, so it stays bindable + offline-safe against real structural QA.
 */
function renderSectionSlot(section: PlanSection, byId: Map<string, CanonicalItem>): string {
  const slot = section.imageSlot;
  if (!slot) return "";
  const label = escapeHtml(section.title);
  if (slot.kind === "icon") {
    // Emit the curated-glyph MARKER (the painter PICKS a name; the packager inlines the real glyph),
    // deterministically choosing the generic platter so packaging/structural tests exercise the path.
    return (
      `<div class="section-slot relative w-full h-32" data-image-slot="${label}" data-motion="fade-in">` +
      `<svg data-icon="platter-generic" class="w-full h-24 text-accent-strong" aria-hidden="true"></svg>` +
      `<span class="text-text">${label}</span></div>`
    );
  }
  const slides = slot.items
    .map((id) => byId.get(id))
    .filter((i): i is CanonicalItem => i !== undefined && (i.images?.length ?? 0) > 0)
    .map((item, n) => {
      const visibility = n === 0 ? "opacity-100" : "opacity-0";
      return (
        `<img class="absolute inset-0 w-full h-full object-cover ${visibility}" ` +
        `data-img-item="${item.id}" data-img-index="0" data-ref="slot-${label}-${n}" ` +
        `alt="${escapeHtml(item.name)}">`
      );
    })
    .join("");
  return (
    `<div class="section-slot relative w-full h-32" data-image-slot="${label}" ` +
    `data-motion="gallery-fade" data-motion-params="interval:5000;fade:800">${slides}` +
    `<span class="text-text">${label}</span></div>`
  );
}

/**
 * Render a section carrying a computed `matrix` as a TRUE row×column comparison table honouring the
 * matrix-first skeleton: `data-matrix` container, one `data-matrix-row` per row, one
 * `data-matrix-cell` per column, a filled cell carrying `data-item-id` + `data-available` + exactly
 * one `<span data-bind="price">`, and a null cell an em-dash with NO price span. Token classes only.
 */
function renderMatrixSection(
  section: PlanSection,
  byId: Map<string, CanonicalItem>,
  slotHtml: string,
): string {
  const matrix = section.matrix!;
  const head =
    `<div data-matrix-head class="row flex gap-2"><span></span>` +
    matrix.columns.map((c) => `<span class="text-text">${escapeHtml(c)}</span>`).join("") +
    `</div>`;
  const body = matrix.rows
    .map((row) => {
      const cells = row.cells
        .map((cell, i) => {
          const column = escapeHtml(matrix.columns[i] ?? "");
          if (cell === null) {
            return `<div class="text-muted" data-matrix-cell="${column}">—</div>`;
          }
          const item = byId.get(cell);
          const price = item?.price ?? item?.sizes?.[0]?.price ?? item?.variants?.[0]?.price ?? 0;
          return (
            `<div class="cell" data-matrix-cell="${column}" data-item-id="${cell}" ` +
            `data-available="${item?.available ?? true}">` +
            `<span class="text-price" data-bind="price">${money(price)}</span></div>`
          );
        })
        .join("");
      return (
        `<div class="row flex gap-2" data-matrix-row="${escapeHtml(row.label)}">` +
        `<span class="text-text">${escapeHtml(row.label)}</span>${cells}</div>`
      );
    })
    .join("");
  return (
    `<section class="section p-4" data-motion="fade-in">` +
    `<h2 class="text-xl text-accent-strong">${escapeHtml(section.title)}</h2>` +
    `${slotHtml}<div class="matrix grid gap-2" data-matrix>${head}${body}</div></section>`
  );
}

/**
 * A per-category cross-fade carousel: stacked `<img>` slides with NO src (the packager inlines
 * the data-URI from `data-img-item`/`data-img-index`), `data-motion="gallery-fade"` (a
 * runtime preset → the packager injects the motion runtime + [data-motion-runtime] marker),
 * first slide visible so a static render still shows a photo.
 */
function renderCarousel(screen: PlanScreen, byId: Map<string, CanonicalItem>): string {
  const slot = screen.imageSlot;
  if (!slot) return "";
  const categoryId = slot.categoryId ?? screen.id;
  const slides = slot.items
    .map((id) => byId.get(id))
    .filter((i): i is CanonicalItem => i !== undefined && (i.images?.length ?? 0) > 0)
    .map((item, n) => {
      const visibility = n === 0 ? "opacity-100" : "opacity-0";
      return (
        `<img class="absolute inset-0 w-full h-full object-cover ${visibility}" ` +
        `data-img-item="${item.id}" data-img-index="0" data-ref="${categoryId}-carousel-${n}" ` +
        `alt="${escapeHtml(item.name)}">`
      );
    })
    .join("");
  if (slides === "") return "";
  return (
    `<div class="carousel relative w-full h-full" data-image-slot="shared" data-motion="gallery-fade" ` +
    `data-motion-params="interval:5000;fade:800">${slides}</div>`
  );
}

/** A minimal brand header band: an `<img data-brand-logo>` (NO src — the packager inlines it) plus
 * optional name/tagline text. Token classes only, no external refs — stays bindable + offline-safe. */
function renderBrandHeader(brand: BrandInput): string {
  const logo = brand.logo
    ? `<img data-brand-logo class="h-16" alt="${escapeHtml(brand.logo.alt ?? "brand logo")}">`
    : "";
  const name = brand.name ? `<span class="text-text">${escapeHtml(brand.name)}</span>` : "";
  const tagline = brand.tagline
    ? `<span class="text-muted">${escapeHtml(brand.tagline)}</span>`
    : "";
  return `<header class="brand-header flex items-center gap-3 p-4" data-motion="fade-in">${logo}${name}${tagline}</header>`;
}

function renderScreen(
  screen: PlanScreen,
  items: readonly CanonicalItem[],
  brand?: BrandInput,
): string {
  const byId = new Map(items.map((i) => [i.id, i]));
  const sections = screen.sections
    .map((section) => {
      // A per-category image slot (comfortable boards): a photo panel or a food-icon panel.
      const slotHtml = renderSectionSlot(section, byId);
      // A section with computed matrix data renders as a comparison table (skeleton shape).
      if (section.matrix) return renderMatrixSection(section, byId, slotHtml);
      const cards = section.items
        .map((id) => byId.get(id))
        .filter((i): i is CanonicalItem => i !== undefined)
        .map((item) => renderItem(item, section.representation))
        .join("");
      return (
        `<section class="section p-4" data-motion="fade-in">` +
        `<h2 class="text-xl text-accent-strong">${escapeHtml(section.title)}</h2>` +
        `${slotHtml}<div class="cards grid gap-3">${cards}</div></section>`
      );
    })
    .join("");

  const carousel = renderCarousel(screen, byId);
  const header = brand !== undefined ? renderBrandHeader(brand) : "";
  return `<main class="screen grid gap-4 p-6">${header}${carousel}${sections}</main>`;
}
