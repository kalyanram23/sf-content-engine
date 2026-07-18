import { randomUUID } from "node:crypto";

import { initLogger } from "braintrust";

import { AutoPainter } from "../composition/auto-painter";
import { CompositionPainter } from "../composition/painter";
import { loadEngineConfig } from "../config/index";
import type { GenerateOutput, ThinPlan } from "../domain/types";
import { createEngine, type ContentEngine } from "../pipeline/engine";
import { bundledThemesDir } from "./bundled-themes";
import { normalizeBrandLogo } from "./image/asset-resolver";
import type { EnginePorts } from "../ports/index";
import type { Planner } from "../ports/planner";
import type { Clock, DebugSink, IdGenerator, Logger, UsageSink } from "../ports/services";
import type { ThemeRepository } from "../ports/theme-repository";
import { createDefaultThemeRepository } from "../theme/presets/index";
import { builtinVocabularies } from "../vocabularies/index";
import { NodeImageFetcher } from "./image/image-fetcher";
import { createFileThemeRepository } from "./theme/file-theme-repository";
import {
  createOpenRouterClient,
  type OpenRouterClientOptions,
  type RoleResilience,
} from "./openrouter/client";
import { OpenRouterComposer } from "./openrouter/composer";
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
   * Ignored if an explicit `themeRepository` is given. Defaults to {@link bundledThemesDir} (this
   * package's own shipped `themes/`) when omitted and that directory can be resolved — so a bare
   * `createNodeEngine({ openRouterApiKey })` still gets all six shipped themes, not just the one
   * code-bundled preset (`botanical`). Pass an explicit `themesDir` to override with your own.
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
    // A fallback model gets a longer per-attempt leash than the primary (it's slower-but-steadier and
    // its healthy big-board generation legitimately exceeds the primary's 300s cap — see D42/D56).
    fallbackTimeoutMs: config.models.fallbackRequestTimeoutMs,
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

  // No explicit `themesDir`: fall back to this package's OWN shipped themes/ (resolved relative
  // to the emitted adapter file, so it works both packed — `dist/node.js` — and from source —
  // tests, `npm run try`). If that can't be resolved either (an unexpected install layout), the
  // engine still runs with just the code-bundled preset rather than throwing at construction.
  const resolvedThemesDir =
    options.themesDir ??
    (() => {
      try {
        return bundledThemesDir();
      } catch {
        return undefined;
      }
    })();

  const themeRepository =
    options.themeRepository ??
    (resolvedThemesDir !== undefined
      ? createFileThemeRepository(resolvedThemesDir, createDefaultThemeRepository())
      : createDefaultThemeRepository());

  // The QA browser, constructed ONCE. The composition painter's `measure` reuses this SAME instance
  // (below) rather than constructing a second PlaywrightBrowser — though, like render(), each
  // measure() call still spins up its own short-lived chromium.launch() process.
  const browser = new PlaywrightBrowser(options.browser ?? {});

  // The composition path (D71). The composer LLM fills the strict order form; the CompositionPainter
  // renders it deterministically (coverage + photo-truth guaranteed by the renderer). The composer is
  // wired exactly like the planner — client + model + reasoning + maxTokens + resilience + usage — so
  // correlation stamping and usage telemetry flow identically. Task 7 deliberately left
  // `maxTokens.compose` / `resilience.compose` unset: the composer emits a tiny JSON, so maxTokens
  // defaults to the model's own and `maxAttempts` to the structured-call default (2); only the optional
  // `fallback.compose` (allowlist-checked at load, D11) is honoured.
  const composeResilience: RoleResilience = {
    ...(config.models.fallback.compose !== undefined
      ? { fallback: config.models.fallback.compose }
      : {}),
  };
  const composer = new OpenRouterComposer(
    client,
    config.models.compose,
    options.logger,
    config.models.reasoning.compose,
    undefined,
    composeResilience,
    options.usage,
  );
  const vocabularies = builtinVocabularies();

  // The free painter (LLM paints raw HTML on-rails) and the composition painter, wrapped by an
  // AutoPainter: `config.painter.mode` decides routing — `auto` (default) sends a theme that names a
  // registered vocabulary to the composition path and everything else to free paint.
  const freePainter = new OpenRouterPainter(
    client,
    config.models.paint,
    options.logger,
    config.models.reasoning.paint,
    config.models.maxTokens.paint,
    resilienceFor("paint"),
    options.usage,
  );
  const compositionPainter = new CompositionPainter({
    composer,
    vocabularies,
    browser,
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const painter = new AutoPainter({
    free: freePainter,
    composition: compositionPainter,
    vocabularies,
    mode: config.painter.mode,
    ...(options.logger ? { logger: options.logger } : {}),
  });

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
    painter,
    packager: new TailwindPackager(),
    browser,
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
