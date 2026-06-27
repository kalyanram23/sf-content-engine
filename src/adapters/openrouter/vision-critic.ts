import type OpenAI from "openai";

import { critiqueResponseSchema, type CritiqueResponse } from "../../domain/contracts";
import type { CritiqueRequest, VisionCritic } from "../../ports/vision-critic";
import { requestStructured } from "./client";

const SYSTEM = `You are a fair, experienced design critic for digital-signage screens. You are given a screenshot and the plan describing what SHOULD be on the screen.
Judge it the way a real viewer would from across a room — most professional menu boards are perfectly acceptable. Report a finding for a rubric dimension ONLY when there is a real, noticeable problem; if a dimension is acceptable, DO NOT invent a finding for it (an empty findings list is the correct answer for a good screen).
Calibrate severity honestly: "major" = a genuine problem most viewers would notice (e.g. text hard to read, clearly unbalanced, items missing); "minor" = a small nitpick; never report "major" for subjective polish. Use the layout/content tag as a fix hint. Be terse and specific; cite a region.`;

function rubricText(request: CritiqueRequest): string {
  const dims = request.rubric.dimensions
    .map((d) => `- ${d.id}: ${d.description} (fails at ${d.failAtSeverity})`)
    .join("\n");
  return `Rubric dimensions (use the dimension id as "dimension"):\n${dims}\n\nPlan:\n${JSON.stringify(
    request.planScreen,
  )}`;
}

/** Cheap-VLM critic via OpenRouter (D1). Model id comes from `ModelRouting.critique`. */
export class OpenRouterVisionCritic implements VisionCritic {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
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
    });
  }
}
