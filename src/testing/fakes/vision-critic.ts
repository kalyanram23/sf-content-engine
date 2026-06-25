import type { CritiqueResponse } from "../../domain/contracts";
import type { CritiqueRequest, VisionCritic } from "../../ports/vision-critic";

/** A critic that returns scripted rubric responses in order (clamped to the last). */
export class ScriptedVisionCritic implements VisionCritic {
  private index = 0;
  readonly callCount = { value: 0 };

  constructor(private readonly responses: readonly CritiqueResponse[] = [{ findings: [] }]) {}

  critique(_request: CritiqueRequest): Promise<CritiqueResponse> {
    const response = this.responses[Math.min(this.index, this.responses.length - 1)] ?? {
      findings: [],
    };
    this.index += 1;
    this.callCount.value += 1;
    return Promise.resolve(response);
  }
}
