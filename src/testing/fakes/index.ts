import { AutoPainter } from "../../composition/auto-painter";
import { CompositionPainter } from "../../composition/painter";
import type { CritiqueResponse } from "../../domain/contracts";
import type { ThinPlan } from "../../domain/types";
import { createEngine, type ContentEngine } from "../../pipeline/engine";
import type { BrowserPort, RenderObservation } from "../../ports/browser";
import type { Composer, EnginePorts, Painter, VocabularyRegistry } from "../../ports/index";
import { createDefaultThemeRepository } from "../../theme/presets/index";
import { builtinVocabularies } from "../../vocabularies/index";
import { cleanObservation, ScriptedBrowser } from "./browser";
import { FakeComposer } from "./composer";
import { FakeImageFetcher } from "./image-fetcher";
import { FakePackager } from "./packager";
import { FakePainter } from "./painter";
import { FakePlanner } from "./planner";
import { FakeClock, FakeIdGenerator } from "./services";
import { ScriptedVisionCritic } from "./vision-critic";

export { FakeClock, FakeIdGenerator, ArrayLogger, noopLogger } from "./services";
export { FakePlanner } from "./planner";
export { FakePainter, type FakePainterOptions } from "./painter";
export { FakePackager } from "./packager";
export { FakeImageFetcher, type FakeImageFetcherOptions } from "./image-fetcher";
export {
  ScriptedBrowser,
  cleanObservation,
  deadSpaceObservation,
  contrastFailObservation,
  overflowObservation,
  overflowClampObservation,
  clippedItemObservation,
  PLACEHOLDER_PNG_BASE64,
  type ObservationOverrides,
} from "./browser";
export { ScriptedVisionCritic } from "./vision-critic";
export { FakeComposer } from "./composer";

export interface FakeEngineOptions {
  /** Hand-authored plan for the FakePlanner (ignored if the input carries its own plan). */
  plan?: ThinPlan;
  /** Scripted browser observations, one per render call (clamped to the last). */
  observations?: RenderObservation[];
  /** Scripted vision-critic responses, one per critique call (clamped to the last). */
  critiques?: CritiqueResponse[];
  /** The composer for the composition path (default {@link FakeComposer}). */
  composer?: Composer;
  /** Registered component vocabularies for the composition path (default {@link builtinVocabularies}). */
  vocabularies?: VocabularyRegistry;
  /** Paint routing mode: "auto" routes vocabulary themes to composition (default), "free" always
   * free-paints, "composition" always composes. Mirrors the Node adapter's config knob. */
  paintMode?: "auto" | "free" | "composition";
  /** Engine config (partial); merged over defaults. */
  config?: unknown;
  /** Override any individual port (advanced). When `ports.painter` is set it becomes the FREE
   * painter the {@link AutoPainter} wraps (not a full painter-port override), so a plain theme still
   * free-paints through it while a vocabulary theme routes to the composition path. */
  ports?: Partial<EnginePorts>;
}

/** Assemble a fully-deterministic engine from fakes — no network, browser, or API key. */
export function createFakeEngine(options: FakeEngineOptions = {}): ContentEngine {
  const browser: BrowserPort =
    options.ports?.browser ?? new ScriptedBrowser(options.observations ?? [cleanObservation()]);
  // The composition seam (D71): AutoPainter routes each board to the CompositionPainter when its
  // theme names a registered vocabulary (auto mode), else to the free painter. A plain theme (no
  // `vocabulary`) is untouched, so every existing fixture free-paints exactly as before.
  const vocabularies = options.vocabularies ?? builtinVocabularies();
  const freePainter: Painter = options.ports?.painter ?? new FakePainter();
  const compositionPainter = new CompositionPainter({
    composer: options.composer ?? new FakeComposer(),
    vocabularies,
    browser,
  });
  const painter = new AutoPainter({
    free: freePainter,
    composition: compositionPainter,
    vocabularies,
    mode: options.paintMode ?? "auto",
    ...(options.ports?.logger ? { logger: options.ports.logger } : {}),
  });
  const ports: EnginePorts = {
    planner: options.ports?.planner ?? new FakePlanner(options.plan),
    themeRepository: options.ports?.themeRepository ?? createDefaultThemeRepository(),
    painter,
    packager: options.ports?.packager ?? new FakePackager(),
    browser,
    visionCritic:
      options.ports?.visionCritic ??
      new ScriptedVisionCritic(options.critiques ?? [{ findings: [] }]),
    imageFetcher: options.ports?.imageFetcher ?? new FakeImageFetcher(),
    clock: options.ports?.clock ?? new FakeClock(),
    idGenerator: options.ports?.idGenerator ?? new FakeIdGenerator(),
    ...(options.ports?.logger ? { logger: options.ports.logger } : {}),
    ...(options.ports?.llmRepairer ? { llmRepairer: options.ports.llmRepairer } : {}),
  };
  return createEngine(ports, options.config);
}
