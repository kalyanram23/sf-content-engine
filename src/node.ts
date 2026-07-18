/**
 * content-engine/node — Node-only entry.
 *
 * Real adapters (OpenRouter LLMs, Playwright browser, Tailwind packager) and the
 * `createNodeEngine` composition root. Importing this entry pulls in the optional peer
 * dependencies (`openai`, `playwright-core`, `tailwindcss`, `@tailwindcss/node`); the main
 * `.` entry never does.
 */

export { createNodeEngine, type NodeEngineOptions } from "./adapters/node-engine";
export { bundledThemesDir } from "./adapters/bundled-themes";

export {
  createOpenRouterClient,
  requestStructured,
  requestText,
  toStrictJsonSchema,
  OPENROUTER_BASE_URL,
  type OpenRouterClientOptions,
  type StructuredCall,
  type UserContent,
} from "./adapters/openrouter/client";
export { OpenRouterPainter } from "./adapters/openrouter/painter";
export { OpenRouterVisionCritic } from "./adapters/openrouter/vision-critic";
export { OpenRouterRepairer } from "./adapters/openrouter/repairer";
export { PlaywrightBrowser, type PlaywrightBrowserOptions } from "./adapters/playwright/browser";
export { TailwindPackager } from "./adapters/tailwind/packager";
export { StaticPlanner } from "./adapters/planner/static-planner";
export { NodeImageFetcher, type NodeImageFetcherOptions } from "./adapters/image/image-fetcher";
export {
  FileThemeRepository,
  createFileThemeRepository,
} from "./adapters/theme/file-theme-repository";
