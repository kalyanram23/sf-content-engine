import type { CritiqueResponse } from "../../domain/contracts";
import type { ThinPlan } from "../../domain/types";
import { createEngine, type ContentEngine } from "../../pipeline/engine";
import type { BrowserPort, RenderObservation } from "../../ports/browser";
import type { EnginePorts } from "../../ports/index";
import { createDefaultThemeRepository } from "../../theme/presets/index";
import { cleanObservation, ScriptedBrowser } from "./browser";
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

export interface FakeEngineOptions {
  /** Hand-authored plan for the FakePlanner (ignored if the input carries its own plan). */
  plan?: ThinPlan;
  /** Scripted browser observations, one per render call (clamped to the last). */
  observations?: RenderObservation[];
  /** Scripted vision-critic responses, one per critique call (clamped to the last). */
  critiques?: CritiqueResponse[];
  /** Engine config (partial); merged over defaults. */
  config?: unknown;
  /** Override any individual port (advanced). */
  ports?: Partial<EnginePorts>;
}

/** Assemble a fully-deterministic engine from fakes — no network, browser, or API key. */
export function createFakeEngine(options: FakeEngineOptions = {}): ContentEngine {
  const browser: BrowserPort =
    options.ports?.browser ?? new ScriptedBrowser(options.observations ?? [cleanObservation()]);
  const ports: EnginePorts = {
    planner: options.ports?.planner ?? new FakePlanner(options.plan),
    themeRepository: options.ports?.themeRepository ?? createDefaultThemeRepository(),
    painter: options.ports?.painter ?? new FakePainter(),
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
