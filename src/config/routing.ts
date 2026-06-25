import { z } from "zod";

import { findingSourceSchema, findingTagSchema, severitySchema } from "../domain/schemas";
import { deepFreeze } from "../util/freeze";

/** Where the QA router can send the loop next (spec §5.6). */
export const routeSchema = z.enum(["repair", "paint", "plan", "freeze"]);
export type Route = z.infer<typeof routeSchema>;

/** A predicate over a finding. All present fields must match (AND). */
export const routingMatchSchema = z.object({
  source: findingSourceSchema.optional(),
  kindAnyOf: z.array(z.string().min(1)).optional(),
  tagAnyOf: z.array(findingTagSchema).optional(),
  minSeverity: severitySchema.optional(),
  deterministicallyFixable: z.boolean().optional(),
});

export const routingRuleSchema = z.object({
  id: z.string().min(1),
  when: routingMatchSchema,
  route: routeSchema,
  /** Higher wins. The first matching rule by descending priority decides the route. */
  priority: z.number().int(),
});

/**
 * The §5.6 hybrid routing policy, expressed as data (rules-as-data). The evaluator lives
 * in `pipeline/router.ts`; changing routing is a config edit, never an engine edit.
 *
 * Default policy, highest priority first:
 *  1. a structural-capacity finding (planned > slot capacity) → re-plan (a concrete signal,
 *     not a severity — review S1);
 *  2. a deterministically-fixable mechanical finding → repair (cheap/free, never the
 *     painter — §5.6);
 *  3. any other actionable finding → re-paint (minimal-change-first default — §10.6).
 * No actionable findings (or budget exhausted) → freeze (handled by the evaluator).
 */
export const routingRulesSchema = z.object({
  rules: z.array(routingRuleSchema).default([
    {
      id: "structural-capacity-to-replan",
      when: { kindAnyOf: ["overflow-capacity"] },
      route: "plan",
      priority: 100,
    },
    {
      id: "mechanical-fix-to-repair",
      when: { source: "deterministic", deterministicallyFixable: true },
      route: "repair",
      priority: 90,
    },
    {
      id: "actionable-to-repaint",
      when: { minSeverity: "major" },
      route: "paint",
      priority: 10,
    },
  ]),
});

export type RoutingMatch = z.infer<typeof routingMatchSchema>;
export type RoutingRule = z.infer<typeof routingRuleSchema>;
export type RoutingRules = z.infer<typeof routingRulesSchema>;

export const defaultRoutingRules = (): RoutingRules => deepFreeze(routingRulesSchema.parse({}));
