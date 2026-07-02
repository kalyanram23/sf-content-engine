import type OpenAI from "openai";

import type { ReasoningSetting } from "../../config/models";
import { critiqueResponseSchema, type CritiqueResponse } from "../../domain/contracts";
import type { CritiqueRequest, VisionCritic } from "../../ports/vision-critic";
import { requestStructured } from "./client";
import { buildBroadcast } from "./correlation";

export const SYSTEM = `You are a fair, experienced design critic for digital-signage screens. You are given a screenshot and the plan describing what SHOULD be on the screen.
Judge it the way a real viewer would from across a room — most professional menu boards are perfectly acceptable. Report a finding for a rubric dimension ONLY when there is a real, noticeable problem; if a dimension is acceptable, DO NOT invent a finding for it (an empty findings list is the correct answer for a good screen).
When a DESIGN INTENT or LAYOUT STRATEGY is provided, judge theme-adherence and layout against THAT brief — not against your own taste or a generic notion of "designed".
Calibrate severity honestly: "major" = a genuine problem most viewers would notice (e.g. text hard to read, clearly unbalanced, items missing); "minor" = a small nitpick; never report "major" for subjective polish. Use the layout/content tag as a fix hint. Be terse and specific; cite a region.`;

export function rubricText(request: CritiqueRequest): string {
  const dims = request.rubric.dimensions
    .map((d) => `- ${d.id}: ${d.description} (fails at ${d.failAtSeverity})`)
    .join("\n");
  const sections = [`Rubric dimensions (use the dimension id as "dimension"):\n${dims}`];
  if (request.designIntent !== undefined) {
    sections.push(`DESIGN INTENT (what the theme asked for):\n${request.designIntent}`);
  }
  if (request.layoutStrategy !== undefined) {
    sections.push(`LAYOUT STRATEGY the painter was told to follow:\n${request.layoutStrategy}`);
  }
  if (request.canvas !== undefined) {
    const { width, height, aspect } = request.canvas;
    sections.push(
      `Target canvas: ${width}x${height}px (aspect ${aspect}) — a fixed, non-scrolling signage poster. Judge fill, balance and hierarchy for this exact ${aspect === "9:16" ? "portrait" : "landscape"} frame.`,
    );
  }
  sections.push(`Plan:\n${JSON.stringify(request.planScreen)}`);
  return sections.join("\n\n");
}

/** Cheap-VLM critic via OpenRouter (D1). Model id comes from `ModelRouting.critique`. */
export class OpenRouterVisionCritic implements VisionCritic {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
    private readonly reasoning?: ReasoningSetting,
  ) {}

  critique(request: CritiqueRequest): Promise<CritiqueResponse> {
    return requestStructured(this.client, {
      model: this.model,
      schema: critiqueResponseSchema,
      schemaName: "critique",
      system: SYSTEM,
      user: [
        { type: "text", text: rubricText(request) },
        {
          type: "image_url",
          image_url: { url: `data:image/png;base64,${request.screenshotBase64}` },
        },
      ],
      ...(this.reasoning !== undefined ? { reasoning: this.reasoning } : {}),
      ...buildBroadcast(request.correlation, "critique"),
    });
  }
}
