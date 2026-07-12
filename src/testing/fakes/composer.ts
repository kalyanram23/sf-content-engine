import type { CompositionResponse } from "../../domain/contracts";
import type { ComposeRequest, Composer } from "../../ports/composer";

/** The default scripted composition: no blocks, so the renderer's coverage guarantee appends every
 * section itself — a valid, fully-covering board that binds every planned item deterministically. */
const DEFAULT_COMPOSITION: CompositionResponse = { title: "Board", blocks: [] };

/**
 * A composer that returns scripted {@link CompositionResponse}s in order (clamped to the last) —
 * the composition-path sibling of {@link ScriptedVisionCritic}. Every {@link ComposeRequest} is
 * captured on `requests` (and counted on `callCount`) so a test can prove a re-compose happened and
 * inspect the findingsNote the pipeline threaded in after QA.
 *
 * A response with empty `blocks` is intentional and sufficient: {@link renderComposed}'s coverage
 * guarantee appends every forgotten section as a full-width block, so the board still binds all its
 * items without the fake having to parse the digest.
 */
export class FakeComposer implements Composer {
  private index = 0;
  readonly callCount = { value: 0 };
  readonly requests: ComposeRequest[] = [];

  constructor(private readonly script: readonly CompositionResponse[] = [DEFAULT_COMPOSITION]) {}

  compose(request: ComposeRequest): Promise<CompositionResponse> {
    this.requests.push(request);
    const response =
      this.script[Math.min(this.index, this.script.length - 1)] ?? DEFAULT_COMPOSITION;
    this.index += 1;
    this.callCount.value += 1;
    return Promise.resolve(response);
  }
}
