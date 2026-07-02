import type { BrowserPort } from "./browser";
import type { ImageFetcher } from "./image-fetcher";
import type { Packager } from "./packager";
import type { Painter } from "./painter";
import type { Planner } from "./planner";
import type { LlmRepairer } from "./repairer";
import type { Clock, DebugSink, IdGenerator, Logger } from "./services";
import type { ThemeRepository } from "./theme-repository";
import type { VisionCritic } from "./vision-critic";

export type { Planner } from "./planner";
export type { ThemeRepository } from "./theme-repository";
export type { Painter, PaintRequest } from "./painter";
export type { Packager, PackageRequest } from "./packager";
export type {
  BrowserPort,
  RenderRequest,
  RenderResult,
  RenderObservation,
  TextSample,
  ImageObservation,
  BoundingBox,
  Rgba,
} from "./browser";
export type { VisionCritic, CritiqueRequest } from "./vision-critic";
export type { LlmRepairer, LlmRepairRequest } from "./repairer";
export type { ImageFetcher } from "./image-fetcher";
export type { Clock, IdGenerator, Logger, DebugSink, DebugCapture } from "./services";
export type { RequestCorrelation } from "./correlation";

/**
 * Everything the engine depends on, injected at the composition root (build brief). The
 * core never constructs these. `logger` and `llmRepairer` are optional (deterministic
 * repairs are pure-core — D13).
 */
export interface EnginePorts {
  planner: Planner;
  themeRepository: ThemeRepository;
  painter: Painter;
  packager: Packager;
  browser: BrowserPort;
  visionCritic: VisionCritic;
  /** Resolves remote item photos to offline-safe data-URIs before paint/QA (spec §5.1). */
  imageFetcher: ImageFetcher;
  clock: Clock;
  idGenerator: IdGenerator;
  logger?: Logger;
  /** Optional per-iteration artifact capture for debugging the QA loop. */
  debug?: DebugSink;
  llmRepairer?: LlmRepairer;
}
