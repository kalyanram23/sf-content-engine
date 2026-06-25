/**
 * content-engine — public entry (pure, framework-agnostic, no import side effects).
 *
 * Turns a normalized menu into finished digital-signage screens via a
 * "free paint on rails" pipeline with a generator–critic QA loop.
 *
 * Boundary-only surface (DECISIONS D16): the schemas you validate against, the config you
 * supply, the errors you catch, the port types you implement, and the engine factory.
 * Internal value-object shapes are exported as types only.
 *
 * See ARCHITECTURE.md for the module map and DECISIONS.md for design rationale.
 */

export const VERSION = "0.1.0";

/* ----------------------------------------------------------------- boundary schemas */
export { generateInputSchema, generateOutputSchema } from "./domain/schemas";

/* ----------------------------------------------------------------- domain types (type-only) */
export type {
  CanonicalItem,
  ItemSize,
  ItemVariant,
  ThemeBrief,
  Density,
  GenerateConstraints,
  GenerateInput,
  GenerateOutput,
  ThinPlan,
  PlanScreen,
  PlanSection,
  Representation,
  ResolvedTheme,
  ThemePreset,
  ThemeTokens,
  MotionPreset,
  QaFinding,
  QaReport,
  QaScreenReport,
  Severity,
  FindingSource,
  FindingTag,
  SelfContainedScreen,
  Poster,
} from "./domain/types";

/* ----------------------------------------------------------------- errors */
export {
  ContentEngineError,
  ValidationError,
  UnsupportedConstraintError,
  ThemeNotFoundError,
  PaintError,
  PackagingError,
  RenderError,
  LlmContractError,
  QaBudgetError,
  ConfigError,
  type ContentEngineErrorCode,
} from "./domain/errors";

/* ----------------------------------------------------------------- config-as-data */
export {
  loadEngineConfig,
  defaultEngineConfig,
  engineConfigSchema,
  defaultRoutingRules,
  defaultRubric,
  defaultQaConfig,
  defaultLoopConfig,
  defaultTokenLintRules,
  defaultModelRouting,
  type EngineConfig,
  type RoutingRules,
  type RoutingRule,
  type Route,
  type VisionRubricConfig,
  type RubricDimension,
  type QaConfig,
  type LoopConfig,
  type TokenLintRules,
  type ModelRouting,
  type ModelRole,
} from "./config/index";

/* ----------------------------------------------------------------- ports (type-only) */
export type {
  EnginePorts,
  Planner,
  ThemeRepository,
  Painter,
  PaintRequest,
  Packager,
  PackageRequest,
  BrowserPort,
  RenderRequest,
  RenderResult,
  RenderObservation,
  TextSample,
  ImageObservation,
  BoundingBox,
  Rgba,
  VisionCritic,
  CritiqueRequest,
  LlmRepairer,
  LlmRepairRequest,
  Clock,
  IdGenerator,
  Logger,
} from "./ports/index";

/* ----------------------------------------------------------------- themes + engine */
export {
  botanicalPreset,
  InMemoryThemeRepository,
  createDefaultThemeRepository,
} from "./theme/presets/index";
export { resolveTheme } from "./theme/resolve";
export { createEngine, type ContentEngine } from "./pipeline/engine";
