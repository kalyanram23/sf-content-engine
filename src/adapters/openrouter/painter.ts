import type OpenAI from "openai";

import type { ReasoningSetting } from "../../config/models";
import { PaintError } from "../../domain/errors";
import type { BrandInput, ResolvedTheme } from "../../domain/types";
import { describeLayoutStrategy, renderBlueprintStrategy } from "../../planning/layout-strategy";
import type { Painter, PaintRequest } from "../../ports/painter";
import type { Logger } from "../../ports/services";
import { requestText } from "./client";
import { buildBroadcast } from "./correlation";

// Layout strategy is core logic shared with the vision critic; re-exported so existing
// consumers/tests importing it from the painter keep working.
export { describeLayoutStrategy, isMatrixBoard } from "../../planning/layout-strategy";

/** The painter's role line. Canvas size is deliberately not hardcoded here (9:16 boards exist);
 * the exact pixels arrive in the user prompt as "Target canvas". */
const PAINTER_ROLE = `You are an expert digital-signage screen designer creating ONE self-contained screen for a TV that guests read across a room. The screen is a FIXED, non-scrolling POSTER canvas — not a web page: no scrolling, no fold, no responsive reflow; you compose one exact-pixel frame (the canvas size is given under "Target canvas" below).`;

/**
 * Fallback visual identity when a theme declares none of its own. A theme's identity
 * (creative direction + decoration voice) lives in its externalized file (`themes/<id>.theme.json`).
 */
const DEFAULT_IDENTITY = `Visual identity: clean, modern, appetising — design intentionally around the provided theme tokens, not as a generic template.`;

/**
 * Engine-invariant DESIGN GOALS, shared by every theme. This is the boilerplate that used to be
 * copy-pasted into each theme's prompt; keeping it here means a theme file only authors what makes
 * it unique (identity + decoration), and these goals stay consistent as the engine evolves.
 */
const ENGINE_DESIGN_GOALS = `DESIGN GOALS (always apply, in addition to the theme identity above):
- FILL THE SCREEN: structure the root as a full-height column (min-h-screen flex flex-col) whose content area is flex-1 and uses a grid whose rows STRETCH so cards reach near the bottom edge; never leave the bottom half or any large band empty. Use large type and large cards so the layout reads as full, with even, modest margins.
- HIERARCHY: strong title-led hierarchy — the screen title dominates (confident, not oversized); section headers are clearly distinct from item names (larger and/or accent-coloured, with a divider); item names are large and high-contrast. Long multi-word dish names wrap to two or three lines rather than shrink or truncate.
- Within a stretched card, vertically centre the item's name + price block.
- Make the screen appetising and instantly scannable, intentionally designed for THIS theme rather than a generic grid — a guest should glance and immediately want to order.`;

/**
 * The NON-NEGOTIABLE technical contract appended to EVERY theme's base prompt. These are engine
 * mechanics — bindings, offline-safety, the photo-placeholder scheme, motion vocab, contrast
 * tokens, the carousel structure — the painter must always honour so QA/packaging succeed
 * regardless of theme. Themes own the creative prompt; the engine owns these rails.
 */
const ENGINE_CONTRACT = `NON-NEGOTIABLE TECHNICAL CONTRACT (always applies, in addition to the theme direction above):
- Use Tailwind utility classes only; colours/spacing/radius MUST come from the theme tokens (e.g. text-text, bg-surface, text-price). NEVER use raw hex or px arbitrary values (no text-[#fff], no p-[7px], never hardcode the canvas size in a class). For full-bleed sizing use w-full / h-full / min-h-screen and flex/grid. EXCEPTION: box-shadow has no token utility — a hard offset shadow may use a rem-based arbitrary value with a theme var (e.g. shadow-[0.5rem_0.5rem_0_var(--color-text)]), still never px or hex inside the brackets.
- Every menu item element MUST have data-item-id="<id>" and data-available, and every dynamic price MUST be in a <span data-bind="price">.
- Use motion ONLY via data-motion="<name>" from the provided motion vocabulary. No hand-rolled requestAnimationFrame.
- Fully self-contained: no external URLs, no <script> navigation (no location/history/window.open/meta refresh).
- PHOTOS: render an item's photo as an <img> with NO src attribute. Instead carry data-img-item="<itemId>" data-img-index="0" and a unique data-ref="<something>"; the engine inlines the real image (as a data-URI) at package time. NEVER put a URL in src. Only reference photos for item ids listed as having a photo.
- TEXT OVER PHOTOS: NEVER place text (names, prices, descriptions, labels, badges) directly on top of a photo — photos are busy/mid-toned and text over them fails the 4.5:1 contrast gate. Put text on a SOLID theme surface beside/below the photo; if a caption must overlay a photo, give it its own solid or strong-gradient scrim panel. The price must always be on a solid surface.
- TEXT COLOUR CONTRAST (every text element must clear 4.5:1): primary text is text-text; secondary/description text is text-muted; prices are text-price. For ANY accent-coloured text (tags, labels, small headings, "POPULAR"/"CHEF'S SPECIAL" pills) use text-accent-strong, NEVER text-accent (text-accent is a dim decoration/border colour that fails as text). Badge pills must use a solid bg with high-contrast text. Text must contrast with the surface it sits ON: on a dark surface never use black, near-black, or any dark text colour; on a light surface never use white, near-white, or any pale text colour. The theme's text/muted/price/accent-strong tokens are tuned to pass 4.5:1 on the theme's own surfaces — stay on them.
- CAROUSEL (gallery-fade): the one way to cross-fade photos — used both for a plan imageSlot and for any section photo hero. Build a relative, overflow-hidden container carrying data-motion="gallery-fade" and data-motion-params from that preset's params in the motion vocabulary above (format "interval:<ms>;fade:<ms>"). Inside it stack 2 or more <img> (each absolutely positioned, class "absolute inset-0 w-full h-full object-cover"), the FIRST with opacity-100 and the REST with opacity-0, all using the data-img-item/data-img-index/data-ref scheme above. Build a carousel only where the plan calls for it: an imageSlot, or a hero the LAYOUT STRATEGY asks for.
- SECTIONS: the screen has one or more sections, each with a title, a representation, an item list, and an optional layoutHint. Render EVERY section — show its title as a clear header and include EVERY planned item with its data-item-id; never drop, summarise, or "..." items to save space. How items, photos and heroes are arranged for THIS board is set by the LAYOUT STRATEGY in the board details below; build any rotating photo hero as the CAROUSEL above, and a hero must be a clearly-visible block (a real fraction of its area, never a tiny corner thumbnail/icon/chip).
- LAYOUT HINT: if a section has a layoutHint, FOLLOW it. For a price matrix/table (e.g. "rows = base dish, columns = Biryani | Pulav"), lay the shared base dish down the rows and the named categories across the columns; put each price in its own <span data-bind="price"> and give every cell the matching item's data-item-id and data-available.
- ITEM ROWS (name + price): keep each item's name and its price together as one tight unit — the price sits immediately after the name (small gap), or fill the gap between them with a dotted leader. NEVER push the price to the far edge with ml-auto / justify-between leaving a wide hollow gap, and do NOT spread rows vertically with justify-between; pack rows top-aligned with a consistent small gap. Give every price span the tabular-nums class so digits align down a column.
- IMAGE SIZING: an item photo must fill a generous, well-proportioned area (e.g. aspect-video / aspect-square / aspect-[4/3] / aspect-[3/2]) with object-cover so it never distorts — photo on top of the card, or a large square beside the text. NEVER cram a photo into a thin fixed-width full-height vertical strip (e.g. a w-16/w-20 column that stretches to row height) or a short full-width sliver; both squeeze the image to the wrong aspect ratio.
- TYPE SIZE (read across a room, ~10-20 ft): use large type. Item names and prices are at LEAST text-lg (text-xl+ when space allows), section/category headers clearly larger still; never render item text below text-base. Prefer fewer, larger rows that fill the available height over many tiny rows separated by empty space; reclaim wasted space (kill large empty gaps and oversized margins) BEFORE shrinking text, and never shrink below these minimums.
- Everything must fit INSIDE the target canvas given below (Target canvas) — never overflow or require scrolling.
- DECORATION (optional, only when the theme direction asks for it): you MAY enrich the screen with your own inline decorative SVG/CSS — an ambient backdrop and/or small accents. It MUST be inline (no external URLs, no src) and self-contained. Colour it with theme tokens ONLY: fill="var(--color-accent)" / stroke="var(--color-accent)" (any token name), or fill="currentColor" with a token text class — NEVER a raw hex or rgb() in fill/stroke/style. Decoration is secondary: place it BEHIND the content (e.g. low opacity, negative or low z-index, or in the margins) so it never lowers text contrast — names, prices and descriptions stay on solid theme surfaces. Mark purely decorative SVG aria-hidden="true", and never let it overflow the target canvas or push content out of frame.
- FINAL SELF-CHECK: before returning, silently re-check your HTML against this contract and the board's planned sections, and fix any violation in place — but NEVER drop, summarise, or shorten a planned item to make things fit; reclaim wasted space and stay within the type-size minimums instead.
- Return ONLY the HTML for the screen body (a single root element). No markdown fences.`;

/**
 * Compose the painter system prompt: role + the theme's identity (+ its DO/DON'T lists) +
 * the shared engine design goals + the engine contract. Themes own the look/voice; the
 * engine owns the rails. Structured `design` wins over the legacy `prompt` blob.
 */
export function buildSystem(theme: ResolvedTheme): string {
  const design = theme.design;
  const identity =
    design?.identity.trim() ??
    (theme.prompt && theme.prompt.trim() !== "" ? theme.prompt.trim() : DEFAULT_IDENTITY);
  const doList =
    design !== undefined && design.do.length > 0
      ? `DO (this theme):\n${design.do.map((d) => `- ${d}`).join("\n")}`
      : undefined;
  const dontList =
    design !== undefined && design.dont.length > 0
      ? `DON'T (this theme):\n${design.dont.map((d) => `- ${d}`).join("\n")}`
      : undefined;
  return [PAINTER_ROLE, identity, doList, dontList, ENGINE_DESIGN_GOALS, ENGINE_CONTRACT]
    .filter((s): s is string => s !== undefined)
    .join("\n\n");
}

/**
 * Conventional colour-token roles, so the painter reasons about token RELATIONSHIPS ("accent is
 * decoration, accent-strong is accent text") instead of guessing from a bare name list. Themes
 * using other token names simply get the name without a role annotation.
 */
const TOKEN_ROLES: Record<string, string> = {
  bg: "page background",
  surface: "card/panel background",
  "surface-strong": "stronger panel — header bands, emphasized cards, badge/pill fills",
  text: "primary text (item names, titles)",
  muted: "secondary text (descriptions, meta)",
  accent: "decoration ONLY — borders, dividers, backdrop art; never text",
  "accent-strong": "accent-coloured TEXT (tags, labels, small headings) and pill fills",
  price: "price text",
  sold: "marking sold-out / unavailable items only",
};

/** Render each colour token with its role, e.g. `accent (decoration ONLY — …)`. */
function describeTokenRoles(colors: Record<string, string>): string {
  return Object.keys(colors)
    .map((name) => {
      const role = TOKEN_ROLES[name];
      return role ? `${name} — ${role}` : name;
    })
    .join("; ");
}

/**
 * Render the theme's component recipes for the painter: role + each bound slot mapped to its
 * Tailwind token class (e.g. `bg→bg-surface-strong`) + the scarcity rule. Binds are already
 * validated to resolve at load, so this is a plain lookup.
 */
function describeComponents(
  components: readonly { role: string; binds: Record<string, string>; rule: string }[],
): string {
  const lines = components.map((c) => {
    const binds = Object.entries(c.binds)
      .map(([slot, token]) => `${slot}→${token}`)
      .join(", ");
    return `- ${c.role}${binds ? ` (${binds})` : ""}: ${c.rule}`;
  });
  return `Component recipes — reuse these consistently across the board:\n${lines.join("\n")}`;
}

/** The brand-header instruction block appended to the painter's user prompt when a run has brand
 * content. Uses the item-photo placeholder scheme so the large data-URI never passes through the
 * model (an LLM can't reproduce a long base64 blob reliably). */
export function brandUserLines(brand: BrandInput): string[] {
  const lines: string[] = [
    "BRAND HEADER — this run has brand content; render a header band at the TOP of the screen combining the brand with the screen title:",
    "- Place the logo as <img data-brand-logo> with NO src attribute — the engine inlines the real image at package time. NEVER put a URL in src.",
    "- Size the logo as a real header element (not a tiny thumbnail, not overpowering the menu), on a theme surface that suits it (transparent logos need an appropriate backing).",
  ];
  if (brand.logo?.alt !== undefined)
    lines.push(`- Logo alt text: ${JSON.stringify(brand.logo.alt)}`);
  if (brand.name !== undefined)
    lines.push(`- Brand name (render as text in the header): ${JSON.stringify(brand.name)}`);
  if (brand.tagline !== undefined)
    lines.push(`- Tagline (smaller text near the name): ${JSON.stringify(brand.tagline)}`);
  return lines;
}

export function describeRequest(request: PaintRequest): string {
  const tokens = request.theme.tokens;
  const motion = request.theme.motion
    .map((m) => `${m.name} (${m.kind}${m.params ? `, params ${JSON.stringify(m.params)}` : ""})`)
    .join(", ");
  // Strip image data-URIs from the item payload (they are inlined at package time): keep only
  // a photo COUNT so the prompt stays small. The painter references photos by data-img-item.
  const slimItems = request.items.map((item) => {
    const { images: _images, ...rest } = item;
    return { ...rest, photoCount: item.images?.length ?? 0 };
  });
  const withPhotos = request.items.filter((i) => (i.images?.length ?? 0) > 0).map((i) => i.id);
  const lines: string[] = [
    `Theme: ${request.theme.name} (density: ${request.theme.density}${request.theme.motif ? `, motif: ${request.theme.motif}` : ""})`,
    `Colour tokens — use as Tailwind classes text-<name> / bg-<name> / border-<name> (e.g. text-text, bg-surface, text-price). Roles: ${describeTokenRoles(tokens.colors)}.`,
    `Motion vocabulary: ${motion}`,
    `Locale: ${request.constraints.locale}, currency: ${request.constraints.currency}`,
    `Target canvas: ${request.viewport?.width ?? 1920}x${request.viewport?.height ?? 1080}px (aspect ${request.constraints.aspect})`,
    ...(request.constraints.aspect === "9:16"
      ? [
          "PORTRAIT (9:16) COMPOSITION: this canvas is tall and narrow — compose a single-column VERTICAL flow: title band at the top, sections stacked full-width down the canvas, items in ONE column (at most two narrow columns for short names). Any photo hero is a full-width horizontal band (roughly the top quarter of the canvas, never half). The type-size minimums are unchanged — the canvas is narrower, not smaller.",
        ]
      : []),
    `Plan: ${JSON.stringify(request.planScreen)}`,
    request.blueprint
      ? renderBlueprintStrategy(request.blueprint)
      : describeLayoutStrategy(request.planScreen),
    `Items: ${JSON.stringify(slimItems)}`,
    `Item ids WITH a photo (only these may use <img>): ${withPhotos.length > 0 ? withPhotos.join(", ") : "(none)"}`,
  ];
  if (request.planScreen.imageSlot) {
    lines.push(
      `Image slot — build a gallery-fade carousel cycling these item photos: ${JSON.stringify(request.planScreen.imageSlot)}`,
    );
  }
  if (request.brand !== undefined) {
    lines.push(...brandUserLines(request.brand));
  }
  if (request.theme.components !== undefined && request.theme.components.length > 0) {
    lines.push(describeComponents(request.theme.components));
  }
  if (request.antiPatterns !== undefined && request.antiPatterns.length > 0) {
    lines.push(
      `NEVER (board-set anti-patterns):\n${request.antiPatterns.map((a) => `- ${a}`).join("\n")}`,
    );
  }
  if (request.previousHtml && request.findings && request.findings.length > 0) {
    lines.push(
      "This is a RE-PAINT. Make the MINIMAL change that resolves these QA findings, preserving everything else:",
      JSON.stringify(
        request.findings.map((f) => ({
          kind: f.kind,
          severity: f.severity,
          message: f.message,
          region: f.region,
        })),
      ),
      "Previous HTML:",
      request.previousHtml,
    );
  }
  return lines.join("\n");
}

/** Frontier-model painter via OpenRouter (D1). Model id comes from `ModelRouting.paint`. */
export class OpenRouterPainter implements Painter {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
    private readonly logger?: Logger,
    private readonly reasoning?: ReasoningSetting,
  ) {}

  async paint(request: PaintRequest): Promise<string> {
    const system = buildSystem(request.theme);
    const user = describeRequest(request);
    const isRepaint = request.previousHtml !== undefined && (request.findings?.length ?? 0) > 0;
    // Surface the exact prompt the painter receives so a `try` run shows how the model is driven.
    // The system prompt is identical across a board's re-paints, so emit it only on the first paint;
    // the user prompt (plan + items, and on a re-paint the findings + previous HTML) goes every time.
    if (!isRepaint) {
      this.logger?.debug(`painter SYSTEM prompt (theme "${request.theme.name}"):\n${system}`);
    }
    // On a re-paint the user prompt embeds the ENTIRE previous HTML; redact that blob from the log
    // (keep the findings + instructions) so debug output stays a readable prompt, not a page dump.
    const userForLog =
      request.previousHtml !== undefined
        ? user.replace(
            request.previousHtml,
            `[previous HTML omitted — ${request.previousHtml.length} chars]`,
          )
        : user;
    this.logger?.debug(
      `painter USER prompt — board "${request.planScreen.id}" (${isRepaint ? "re-paint" : "first paint"}):\n${userForLog}`,
    );
    const html = await requestText(this.client, {
      model: this.model,
      system,
      user,
      // A full screen of dense HTML is large; give the model ample room so it isn't truncated to
      // empty (the painter contract forbids dropping items, so output can't be trimmed to fit).
      maxTokens: 32000,
      ...(this.reasoning !== undefined ? { reasoning: this.reasoning } : {}),
      ...buildBroadcast(request.correlation, "paint"),
    });
    const trimmed = extractScreenHtml(html);
    if (trimmed === "")
      throw new PaintError(
        "painter returned empty HTML (model produced no content — likely truncated or refused; " +
          "if a board is very dense, raise --screens to spread items across more boards).",
      );
    return trimmed;
  }
}

/**
 * Extract the screen HTML from a model response. Models sometimes ignore "no markdown fences" and
 * wrap the markup in a ```html block, and — especially on a re-paint, where the prompt carries QA
 * findings — prefix it with chain-of-thought prose ("Looking at the two findings: 1. …"). We first
 * take the contents of a fenced code block if one is present (even after a prose preamble), then
 * drop any remaining prose before the first real tag — so neither the reasoning nor a stray ```
 * marker can leak into the rendered page.
 */
export function extractScreenHtml(raw: string): string {
  const fenced = raw.match(/```(?:html)?\s*([\s\S]*?)```/i);
  let html = fenced?.[1] ?? raw;
  const firstTag = html.search(
    /<(?:!doctype|html|body|div|section|main|article|header|ul|ol|table)\b/i,
  );
  if (firstTag > 0) html = html.slice(firstTag);
  return html.trim();
}
