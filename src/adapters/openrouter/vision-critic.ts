import type OpenAI from "openai";

import type { ReasoningSetting } from "../../config/models";
import { critiqueResponseSchema, type CritiqueResponse } from "../../domain/contracts";
import type { Logger, UsageSink } from "../../ports/services";
import type { CritiqueRequest, VisionCritic } from "../../ports/vision-critic";
import {
  buildUsageReporter,
  requestStructured,
  resilienceFields,
  type RoleResilience,
} from "./client";
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
  if (request.densityTier === "dense" || request.densityTier === "packed") {
    const count =
      request.itemCount !== undefined ? `${request.itemCount} menu items` : "many menu items";
    sections.push(
      `DENSITY: this is a ${request.densityTier.toUpperCase()} board (${count}) — the plan forced ` +
        `far more items onto it than a boutique layout can breathe around, so it was DELIBERATELY ` +
        `designed as a compact, information-dense price wall (tight rows, multi-column, headers as ` +
        `the structure, few or no photos). Judge theme-adherence, intentional-design and ` +
        `representation-clarity as "is this a WELL-EXECUTED dense board" — a clean, scannable, ` +
        `well-organised dense wall is a SUCCESS. Do NOT penalise it for tight spacing, small type, ` +
        `absence of large heroes or generous whitespace: that register is required here, not a flaw. ` +
        `Only report a finding for genuine problems (illegible/overlapping text, real imbalance, ` +
        `items clearly missing, actual overflow).`,
    );
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
    private readonly logger?: Logger,
    private readonly reasoning?: ReasoningSetting,
    private readonly maxTokens?: number,
    private readonly resilience?: RoleResilience,
    private readonly usage?: UsageSink,
  ) {}

  critique(request: CritiqueRequest): Promise<CritiqueResponse> {
    const onUsage = buildUsageReporter(this.logger, this.usage, "critique", this.model);
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
      ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
      ...resilienceFields(this.resilience),
      ...(onUsage !== undefined ? { onUsage } : {}),
      ...buildBroadcast(request.correlation, "critique"),
    });
  }
}
