import type { CanonicalItem, PlanScreen, Representation } from "../../domain/types";
import type { PaintRequest, Painter } from "../../ports/painter";

/**
 * A deterministic painter that emits genuinely valid, bindable HTML on the rails: token
 * utility classes (no raw hex/px), `data-item-id`/`data-bind` hooks, `data-motion` from the
 * vocabulary, no external refs, no navigation. Real structural QA runs against this output;
 * rendered issues (contrast/density) are simulated by the {@link ScriptedBrowser}.
 */
export class FakePainter implements Painter {
  paint(request: PaintRequest): Promise<string> {
    return Promise.resolve(renderScreen(request.planScreen, request.items));
  }
}

function money(n: number): string {
  return `$${n.toFixed(2)}`;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function renderItem(item: CanonicalItem, representation: Representation): string {
  const head = `<h3 class="text-lg text-text">${escapeHtml(item.name)}</h3>`;
  let body = "";

  if (representation === "matrix" && item.sizes && item.sizes.length > 0) {
    const cells = item.sizes
      .map(
        (s) =>
          `<div class="cell flex gap-2"><span class="text-muted">${escapeHtml(s.label)}</span>` +
          `<span class="text-price" data-bind="price">${money(s.price)}</span></div>`,
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
    const price = item.price ?? item.sizes?.[0]?.price ?? 0;
    body = `<span class="text-price" data-bind="price">${money(price)}</span>`;
  }

  return (
    `<article class="menu-item rounded-md bg-surface p-3" data-item-id="${item.id}" ` +
    `data-available="${item.available}">${head}${body}</article>`
  );
}

function renderScreen(screen: PlanScreen, items: readonly CanonicalItem[]): string {
  const byId = new Map(items.map((i) => [i.id, i]));
  const sections = screen.sections
    .map((section) => {
      const cards = section.items
        .map((id) => byId.get(id))
        .filter((i): i is CanonicalItem => i !== undefined)
        .map((item) => renderItem(item, section.representation))
        .join("");
      return (
        `<section class="section p-4" data-motion="fade-in">` +
        `<h2 class="text-xl text-accent-strong">${escapeHtml(section.title)}</h2>` +
        `<div class="cards grid gap-3">${cards}</div></section>`
      );
    })
    .join("");

  return `<main class="screen grid gap-4 p-6">${sections}</main>`;
}
