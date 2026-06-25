import type OpenAI from "openai";

import { critiqueResponseSchema, type CritiqueResponse } from "../../domain/contracts";
import type { CritiqueRequest, VisionCritic } from "../../ports/vision-critic";
import { requestStructured } from "./client";

const SYSTEM = `You are a strict design critic for digital-signage screens. You are given a screenshot and the plan describing what SHOULD be on the screen. Score the screen against the rubric and report ONLY genuine problems as structured findings. Use the layout/content tag as a hint about how to fix it. Be terse and specific; cite a region.`;

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
