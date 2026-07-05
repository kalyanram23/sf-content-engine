import { randomUUID } from "node:crypto";

import { initLogger } from "braintrust";

import { loadEngineConfig } from "../config/index";
import type { GenerateOutput, ThinPlan } from "../domain/types";
import { createEngine, type ContentEngine } from "../pipeline/engine";
import { normalizeBrandLogo } from "./image/asset-resolver";
import type { EnginePorts } from "../ports/index";
import type { Planner } from "../ports/planner";
import type { Clock, DebugSink, IdGenerator, Logger, UsageSink } from "../ports/services";
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
  /**
   * Optional structured per-call LLM token-usage telemetry (cost visibility). Composed into every
   * OpenRouter adapter alongside the existing `usage …` debug line (both fire); off by default and
   * never affects output (D15/D28). The event carries role/model/tokens + attempt/fallback.
   */
  usage?: UsageSink;
  /**
   * Opt into Braintrust tracing. When set, the engine initializes a Braintrust logger (under
   * `projectName`, default `"content-engine"`) and auto-instruments every LLM call via `wrapOpenAI`.
   * When omitted (default) Braintrust is NOT initialized — the only tracing is OpenRouter Broadcast
   * (`session_id` + `trace`), which needs no extra dependency. Requires Braintrust credentials in the
   * environment / local Braintrust config when enabled.
   */
  braintrust?: { projectName?: string };
}

/**
 * The Node composition root: wires the real OpenRouter / Playwright / Tailwind adapters into
 * the pure engine (build brief). Models are config-as-data (`config.models`); validated at
 * load (D11). Deterministic repairs are pure-core, so the LLM repairer is the fallback (D13).
 */
export function createNodeEngine(options: NodeEngineOptions): ContentEngine {
  // Braintrust tracing is opt-in: only initialize the logger (and client-side auto-instrumentation)
  // when the caller asked for it. The default tracing path is OpenRouter Broadcast, which needs no
  // external logger — so a plain run carries no Braintrust coupling. API key (when enabled) is picked
  // up from the local Braintrust config automatically.
  const braintrustEnabled = options.braintrust !== undefined;
  if (braintrustEnabled) {
    initLogger({ projectName: options.braintrust?.projectName ?? "content-engine" });
  }

  const config = loadEngineConfig(options.config);

  const clientOptions: OpenRouterClientOptions = {
    apiKey: options.openRouterApiKey,
    timeoutMs: config.models.requestTimeoutMs,
    braintrust: braintrustEnabled,
  };
  if (options.appUrl) clientOptions.appUrl = options.appUrl;
  if (options.appName) clientOptions.appName = options.appName;
  const client = createOpenRouterClient(clientOptions);

  // Per-role resilience policy (config-as-data): attempt budget against the primary model + an
  // optional fallback model tried once those attempts are spent. Spread into each LLM adapter so a
  // single empty/non-conforming completion is a retry, not a fatal abort of the whole run.
  const resilienceFor = (
    role: "plan" | "paint" | "critique" | "repair",
  ): { maxAttempts: number; fallback?: string } => {
    const fallback = config.models.fallback[role];
    return {
      maxAttempts: config.models.resilience[role].maxAttempts,
      ...(fallback !== undefined ? { fallback } : {}),
    };
  };

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
        : new OpenRouterPlanner(
            client,
            config.models.plan,
            options.logger,
            config.models.reasoning.plan,
            config.models.maxTokens.plan,
            config.planning,
            resilienceFor("plan"),
            options.usage,
          )),
    themeRepository,
    painter: new OpenRouterPainter(
      client,
      config.models.paint,
      options.logger,
      config.models.reasoning.paint,
      config.models.maxTokens.paint,
      resilienceFor("paint"),
      options.usage,
    ),
    packager: new TailwindPackager(),
    browser: new PlaywrightBrowser(options.browser ?? {}),
    visionCritic: new OpenRouterVisionCritic(
      client,
      config.models.critique,
      options.logger,
      config.models.reasoning.critique,
      config.models.maxTokens.critique,
      resilienceFor("critique"),
      options.usage,
    ),
    imageFetcher: new NodeImageFetcher(),
    llmRepairer: new OpenRouterRepairer(
      client,
      config.models.repair,
      options.logger,
      config.models.reasoning.repair,
      config.models.maxTokens.repair,
      resilienceFor("repair"),
      options.usage,
    ),
    clock: new SystemClock(),
    idGenerator: new SystemIdGenerator(),
    ...(options.logger ? { logger: options.logger } : {}),
    ...(options.debug ? { debug: options.debug } : {}),
    ...(options.usage ? { usage: options.usage } : {}),
  };

  const engine = createEngine(ports, options.config);
  // Resolve any brand logo (URL / fs path) to a data-URI before the pure, hermetic core runs.
  // `plan()` doesn't touch brand, so it delegates unchanged (no needless fetch/read).
  return {
    async generate(input: unknown): Promise<GenerateOutput> {
      return engine.generate(await normalizeBrandLogo(input));
    },
    plan(input: unknown): Promise<ThinPlan> {
      return engine.plan(input);
    },
  };
}
