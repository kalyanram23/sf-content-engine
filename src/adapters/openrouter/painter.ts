import type OpenAI from "openai";

import { PaintError } from "../../domain/errors";
import type { ResolvedTheme } from "../../domain/types";
import type { Painter, PaintRequest } from "../../ports/painter";
import { requestText } from "./client";

/**
 * Fallback base prompt when a theme declares no `prompt` of its own. A theme's own base prompt
 * (creative direction + visual identity) lives in its externalized file (`themes/<id>.theme.json`).
 */
const DEFAULT_BASE_PROMPT = `You are an expert digital-signage screen designer creating ONE self-contained screen for a 1920x1080 TV read across a room. Fill the screen with a balanced, full-height layout; use large type and large cards; strong title-led hierarchy with section headers clearly distinct from item names; keep each item's name and price as one tight block (no hollow justify-between cards); even, purposeful margins. Make it appetising and instantly scannable — a guest should glance and want to order. Design intentionally for the theme, not as a generic grid.`;

/**
 * The NON-NEGOTIABLE technical contract appended to EVERY theme's base prompt. These are engine
 * mechanics — bindings, offline-safety, the photo-placeholder scheme, motion vocab, contrast
 * tokens, the carousel structure — the painter must always honour so QA/packaging succeed
 * regardless of theme. Themes own the creative prompt; the engine owns these rails.
 */
const ENGINE_CONTRACT = `NON-NEGOTIABLE TECHNICAL CONTRACT (always applies, in addition to the theme direction above):
- Use Tailwind utility classes only; colours/spacing/radius MUST come from the theme tokens (e.g. text-text, bg-surface, text-price). NEVER use raw hex or px arbitrary values (no text-[#fff], no p-[7px], no w-[1920px]/h-[1080px]). For full-bleed sizing use w-full / h-full / min-h-screen and flex/grid.
- Every menu item element MUST have data-item-id="<id>" and data-available, and every dynamic price MUST be in a <span data-bind="price">.
- Use motion ONLY via data-motion="<name>" from the provided motion vocabulary. No hand-rolled requestAnimationFrame.
- Fully self-contained: no external URLs, no <script> navigation (no location/history/window.open/meta refresh).
- PHOTOS: render an item's photo as an <img> with NO src attribute. Instead carry data-img-item="<itemId>" data-img-index="0" and a unique data-ref="<something>"; the engine inlines the real image (as a data-URI) at package time. NEVER put a URL in src. Only reference photos for item ids listed as having a photo.
- TEXT OVER PHOTOS: NEVER place text (names, prices, descriptions, labels, badges) directly on top of a photo — photos are busy/mid-toned and text over them fails the 4.5:1 contrast gate. Put text on a SOLID theme surface beside/below the photo; if a caption must overlay a photo, give it its own solid or strong-gradient scrim panel. The price must always be on a solid surface.
- TEXT COLOUR CONTRAST (every text element must clear 4.5:1): primary text is text-text; secondary/description text is text-muted; prices are text-price. For ANY accent-coloured text (tags, labels, small headings, "POPULAR"/"CHEF'S SPECIAL" pills) use text-accent-strong, NEVER text-accent (text-accent is a dim decoration/border colour that fails as text). Badge pills must use a solid bg with high-contrast text. Never use black, near-black, or any dark text colour on the dark theme surfaces.
- IMAGE SLOT / CAROUSEL: when the plan includes an imageSlot, build a cross-fade photo carousel as a relative, overflow-hidden container carrying data-motion="gallery-fade" and data-motion-params set FROM that preset's params in the motion vocabulary above (format "interval:<ms>;fade:<ms>", e.g. from params {interval, fade}). Inside it put ONE <img> per image-slot item, each absolutely stacked (class "absolute inset-0 w-full h-full object-cover"), the FIRST with opacity-100 and the REST with opacity-0, all using the data-img-item/data-img-index/data-ref scheme above.
- Everything must fit INSIDE 1920x1080 — never overflow or require scrolling.
- Return ONLY the HTML for the screen body (a single root element). No markdown fences.`;

/** Compose the painter system prompt: the theme's own base prompt + the engine contract. */
function buildSystem(theme: ResolvedTheme): string {
  const base =
    theme.prompt && theme.prompt.trim() !== "" ? theme.prompt.trim() : DEFAULT_BASE_PROMPT;
  return `${base}\n\n${ENGINE_CONTRACT}`;
}

function describeRequest(request: PaintRequest): string {
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
    `Colour tokens: ${Object.keys(tokens.colors).join(", ")}`,
    `Motion vocabulary: ${motion}`,
    `Locale: ${request.constraints.locale}, currency: ${request.constraints.currency}`,
    `Plan: ${JSON.stringify(request.planScreen)}`,
    `Items: ${JSON.stringify(slimItems)}`,
    `Item ids WITH a photo (only these may use <img>): ${withPhotos.length > 0 ? withPhotos.join(", ") : "(none)"}`,
  ];
  if (request.planScreen.imageSlot) {
    lines.push(
      `Image slot — build a gallery-fade carousel cycling these item photos: ${JSON.stringify(request.planScreen.imageSlot)}`,
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
  ) {}

  async paint(request: PaintRequest): Promise<string> {
    const html = await requestText(this.client, {
      model: this.model,
      system: buildSystem(request.theme),
      user: describeRequest(request),
    });
    const trimmed = stripFences(html).trim();
    if (trimmed === "") throw new PaintError("painter returned empty HTML.");
    return trimmed;
  }
}

/** Strip accidental ```html fences a model might add. */
function stripFences(html: string): string {
  return html.replace(/^```(?:html)?\s*/i, "").replace(/```\s*$/i, "");
}
