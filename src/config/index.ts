import { z } from "zod";

import { ConfigError } from "../domain/errors";
import { parseOrThrow } from "../domain/parse";
import { deepFreeze } from "../util/freeze";
import { executionConfigSchema } from "./execution";
import { layoutsConfigSchema } from "./layouts";
import { loopConfigSchema } from "./loop";
import { type ModelRouting, modelRoutingSchema } from "./models";
import { painterConfigSchema } from "./painter";
import { qaConfigSchema } from "./qa";
import { routingRulesSchema } from "./routing";
import { visionRubricConfigSchema } from "./rubric";
import { tokenLintRulesSchema } from "./token-lint";

/** The full engine configuration — every block is rules/config-as-data with a default. */
export const engineConfigSchema = z.object({
  routing: routingRulesSchema.prefault({}),
  tokenLint: tokenLintRulesSchema.prefault({}),
  rubric: visionRubricConfigSchema.prefault({}),
  qa: qaConfigSchema.prefault({}),
  loop: loopConfigSchema.prefault({}),
  models: modelRoutingSchema.prefault({}),
  painter: painterConfigSchema.prefault({}),
  layouts: layoutsConfigSchema.prefault({}),
  execution: executionConfigSchema.prefault({}),
});

export type EngineConfig = z.infer<typeof engineConfigSchema>;

/** Roles whose outputs are strict JSON and therefore require structured-output support (D11). */
const STRUCTURED_OUTPUT_ROLES = ["plan", "critique", "repair"] as const;

function assertStructuredOutputModels(models: ModelRouting): void {
  const allow = new Set(models.structuredOutputAllowlist);
  const offenders = STRUCTURED_OUTPUT_ROLES.filter((role) => !allow.has(models[role])).map(
    (role) => `${role}=${models[role]}`,
  );
  if (offenders.length > 0) {
    throw new ConfigError(
      `Model routing assigns roles that need structured output to models not on the allowlist: ${offenders.join(
        ", ",
      )}. Add them to models.structuredOutputAllowlist or choose a supported model.`,
      { details: { offenders, allowlist: models.structuredOutputAllowlist } },
    );
  }
}

/**
 * Validate a (partial) config over defaults, assert model capabilities, and deep-freeze.
 * Fails loudly (build brief). Pass `{}` / nothing for the defaults.
 */
export function loadEngineConfig(partial?: unknown): EngineConfig {
  const config = parseOrThrow(engineConfigSchema, partial ?? {}, "engine config");
  assertStructuredOutputModels(config.models);
  return deepFreeze(config);
}

export function defaultEngineConfig(): EngineConfig {
  return loadEngineConfig({});
}

export { loopConfigSchema, defaultLoopConfig, type LoopConfig } from "./loop";
export {
  qaConfigSchema,
  viewportConfigSchema,
  contrastConfigSchema,
  densityConfigSchema,
  defaultQaConfig,
  type QaConfig,
  type ViewportConfig,
  type ContrastConfig,
  type DensityConfig,
} from "./qa";
export { tokenLintRulesSchema, defaultTokenLintRules, type TokenLintRules } from "./token-lint";
export {
  visionRubricConfigSchema,
  rubricDimensionSchema,
  defaultRubric,
  type VisionRubricConfig,
  type RubricDimension,
} from "./rubric";
export {
  routingRulesSchema,
  routingRuleSchema,
  routingMatchSchema,
  routeSchema,
  defaultRoutingRules,
  type RoutingRules,
  type RoutingRule,
  type RoutingMatch,
  type Route,
} from "./routing";
export {
  modelRoutingSchema,
  modelRoleSchema,
  reasoningSettingSchema,
  defaultModelRouting,
  type ModelRouting,
  type ModelRole,
  type ReasoningSetting,
} from "./models";
export { painterConfigSchema, defaultPainterConfig, type PainterConfig } from "./painter";
export { layoutsConfigSchema, defaultLayoutsConfig, type LayoutsConfig } from "./layouts";
export { executionConfigSchema, defaultExecutionConfig, type ExecutionConfig } from "./execution";
