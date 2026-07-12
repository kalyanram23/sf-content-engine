import type OpenAI from "openai";

import type { ReasoningSetting } from "../../config/models";
import { compositionResponseSchema, type CompositionResponse } from "../../domain/contracts";
import type { ComposeRequest, Composer } from "../../ports/composer";
import type { Logger, UsageSink } from "../../ports/services";
import {
  buildUsageReporter,
  requestStructured,
  resilienceFields,
  type RoleResilience,
} from "./client";
import { buildBroadcast } from "./correlation";

/**
 * Compose the composer's SYSTEM prompt: the poster's real canvas dimensions + orientation, the
 * JUDGMENT-ONLY contract (the renderer owns every size/column/coordinate), and the request's
 * `vocabularyPrompt` — the engine-owned block-kind contract described in the theme's own voice.
 * Ported from the validated prototype `prototypes/component-vocab/compose.ts` (`buildSystem`), with
 * the dhaba-specific vocabulary paragraph replaced by the injected {@link ComposeRequest.vocabularyPrompt}
 * so the composer stays theme-agnostic.
 */
export function buildComposerSystem(
  canvas: { width: number; height: number },
  vocabularyPrompt: string,
): string {
  const orientation = canvas.height > canvas.width ? "portrait" : "landscape";
  return `You are the composer for a menu POSTER (${canvas.width}×${canvas.height} ${orientation}). You do NOT write HTML or CSS. You emit a small JSON "composition" that a deterministic renderer expands into the final board using a fixed set of hand-designed components. The renderer arranges your blocks to fill this canvas (stacking them on a tall portrait, or flowing them into balanced newspaper columns on a wide landscape one) — you never think about columns or sizes.

The board masthead (title) and the decorative frame are drawn automatically — you never place them. You choose only the BODY blocks and their order.

${vocabularyPrompt}

You decide JUDGMENT ONLY: the block order, which sections are standalone vs grouped, where the photo band sits, which photos it shows, and the board title. You decide NO sizes, columns, fonts, or coordinates — the renderer computes those to fill the canvas.

Compose it like a gold reference board: lead with the biggest/most important sections, put ONE photo band in to break up the text, and gather the small sections (≈2–4 items) into a group. Every section must appear exactly once (as a "section" or inside a "group"). Keep the JSON tiny.`;
}

/** The user message: the content digest, with the QA findings appended as a re-compose note. */
export function buildComposerUser(digest: string, findingsNote: string | undefined): string {
  if (findingsNote === undefined) return digest;
  return `${digest}\n\nQA found these problems with your previous composition:\n${findingsNote}\nReturn a corrected composition.`;
}

/**
 * The composition LLM adapter (D71): one structured call returns a {@link CompositionResponse} — a
 * closed, theme-agnostic "order form" the composer fills with JUDGMENT only (block order, grouping,
 * photo picks, board title). Structured outputs enforce the shape; the shared client
 * ({@link requestStructured}) handles the one Zod-validation re-ask, correlation stamping, and usage
 * telemetry. The renderer (not this adapter) guarantees coverage + photo-truth regardless of output.
 *
 * Mirrors {@link OpenRouterPlanner}'s constructor shape (client + model + reasoning/token/resilience
 * options), minus the planner's expander-specific planning config — the composer needs none.
 */
export class OpenRouterComposer implements Composer {
  constructor(
    private readonly client: OpenAI,
    private readonly model: string,
    private readonly logger?: Logger,
    private readonly reasoning?: ReasoningSetting,
    private readonly maxTokens?: number,
    private readonly resilience?: RoleResilience,
    private readonly usage?: UsageSink,
  ) {}

  async compose(request: ComposeRequest): Promise<CompositionResponse> {
    const system = buildComposerSystem(request.canvas, request.vocabularyPrompt);
    const user = buildComposerUser(request.digest, request.findingsNote);
    const onUsage = buildUsageReporter(this.logger, this.usage, "compose", this.model);

    return requestStructured<CompositionResponse>(this.client, {
      model: this.model,
      schema: compositionResponseSchema,
      schemaName: "composition",
      system,
      user,
      ...(this.reasoning !== undefined ? { reasoning: this.reasoning } : {}),
      ...(this.maxTokens !== undefined ? { maxTokens: this.maxTokens } : {}),
      ...resilienceFields(this.resilience),
      ...(onUsage !== undefined ? { onUsage } : {}),
      ...buildBroadcast(request.correlation, "compose"),
    });
  }
}
