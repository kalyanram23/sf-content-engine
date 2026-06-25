import type OpenAI from "openai";

import { PaintError } from "../../domain/errors";
import type { Painter, PaintRequest } from "../../ports/painter";
import { requestText } from "./client";

const SYSTEM = `You are a digital-signage screen designer. You PAINT one self-contained HTML+JS screen for a TV.
Hard rules:
- Use Tailwind utility classes only; colours/spacing/radius MUST come from the theme tokens (e.g. text-text, bg-surface, text-price). NEVER use raw hex or px (no text-[#fff], no p-[7px]).
- Every menu item element MUST have data-item-id="<id>" and data-available, and every dynamic price MUST be in a <span data-bind="price">.
- Use motion only via data-motion="<name>" from the provided motion vocabulary. No hand-rolled requestAnimationFrame.
- Fully self-contained: no external URLs, no <script> navigation (no location/history/window.open/meta refresh).
- Lay it out freely for a 16:9 TV. Return ONLY the HTML for the screen body (a single root element). No markdown fences.`;

function describeRequest(request: PaintRequest): string {
  const tokens = request.theme.tokens;
  const motion = request.theme.motion.map((m) => `${m.name} (${m.kind})`).join(", ");
  const lines: string[] = [
    `Theme: ${request.theme.name} (density: ${request.theme.density}${request.theme.motif ? `, motif: ${request.theme.motif}` : ""})`,
    `Colour tokens: ${Object.keys(tokens.colors).join(", ")}`,
    `Motion vocabulary: ${motion}`,
    `Locale: ${request.constraints.locale}, currency: ${request.constraints.currency}`,
    `Plan: ${JSON.stringify(request.planScreen)}`,
    `Items: ${JSON.stringify(request.items)}`,
  ];
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
      system: SYSTEM,
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
