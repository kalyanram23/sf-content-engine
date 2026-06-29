import { randomUUID } from "node:crypto";

import { loadEngineConfig } from "../config/index";
import type { ThinPlan } from "../domain/types";
import { createEngine, type ContentEngine } from "../pipeline/engine";
import type { EnginePorts } from "../ports/index";
import type { Planner } from "../ports/planner";
import type { Clock, DebugSink, IdGenerator, Logger } from "../ports/services";
import type { ThemeRepository } from "../ports/theme-repository";
import { createDefaultThemeRepository } from "../theme/presets/index";
import { NodeImageFetcher } from "./image/image-fetcher";
import { createFileThemeRepository } from "./theme/file-theme-repository";
import { createOpenRouterClient, type OpenRouterClientOptions } from "./openrouter/client";
import { OpenRouterPainter } from "./openrouter/painter";
import { OpenRouterPlanner } from "./openrouter/planner";
import { OpenRouterRepairer } from "./openrouter/repairer";
import { OpenRouterVisionCritic } from "./openrouter/vision-critic";
import { StaticPlanner } from "./planner/static-planner";
import { PlaywrightBrowser, type PlaywrightBrowserOptions } from "./playwright/browser";
import { TailwindPackager } from "./tailwind/packager";

class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

class SystemIdGenerator implements IdGenerator {
  next(prefix: string): string {
    return `${prefix}-${randomUUID()}`;
  }
}

export interface NodeEngineOptions {
  /** OpenRouter API key (`OPENROUTER_API_KEY`). */
  openRouterApiKey: string;
  /** Partial engine config (merged over defaults), including `models` role→id routing. */
  config?: unknown;
  /** Hand-authored plan for v1 (used by the default StaticPlanner). */
  plan?: ThinPlan;
  planner?: Planner;
  themeRepository?: ThemeRepository;
  /**
   * Directory of externalized theme files (`<id>.theme.json`) to load at runtime. Loaded themes
   * override the bundled presets by id; ids not found on disk fall back to the bundled defaults.
   * Ignored if an explicit `themeRepository` is given.
   */
  themesDir?: string;
  browser?: PlaywrightBrowserOptions;
  /** OpenRouter attribution headers. */
  appUrl?: string;
  appName?: string;
  logger?: Logger;
  /** Optional per-iteration artifact capture (HTML/screenshot/findings) for debugging. */
  debug?: DebugSink;
}

/**
 * The Node composition root: wires the real OpenRouter / Playwright / Tailwind adapters into
 * the pure engine (build brief). Models are config-as-data (`config.models`); validated at
 * load (D11). Deterministic repairs are pure-core, so the LLM repairer is the fallback (D13).
 */
export function createNodeEngine(options: NodeEngineOptions): ContentEngine {
  const config = loadEngineConfig(options.config);

  const clientOptions: OpenRouterClientOptions = { apiKey: options.openRouterApiKey };
  if (options.appUrl) clientOptions.appUrl = options.appUrl;
  if (options.appName) clientOptions.appName = options.appName;
  const client = createOpenRouterClient(clientOptions);

  const themeRepository =
    options.themeRepository ??
    (options.themesDir !== undefined
      ? createFileThemeRepository(options.themesDir, createDefaultThemeRepository())
      : createDefaultThemeRepository());

  const ports: EnginePorts = {
    // No explicit planner: use the hand-authored plan if one was supplied, else the LLM coverage
    // planner auto-distributes the whole menu across the requested screen count.
    planner:
      options.planner ??
      (options.plan
        ? new StaticPlanner(options.plan)
        : new OpenRouterPlanner(client, config.models.plan, options.logger)),
    themeRepository,
    painter: new OpenRouterPainter(client, config.models.paint, options.logger),
    packager: new TailwindPackager(),
    browser: new PlaywrightBrowser(options.browser ?? {}),
    visionCritic: new OpenRouterVisionCritic(client, config.models.critique),
    imageFetcher: new NodeImageFetcher(),
    llmRepairer: new OpenRouterRepairer(client, config.models.repair),
    clock: new SystemClock(),
    idGenerator: new SystemIdGenerator(),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.debug ? { debug: options.debug } : {}),
  };

  return createEngine(ports, options.config);
}
