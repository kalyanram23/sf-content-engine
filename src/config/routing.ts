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
 *  1. a structural-capacity finding (planned > slot capacity) → freeze flagged. Capacity
 *     overflow can't be fixed by re-paint OR re-plan (items are ground truth — never dropped;
 *     and the per-screen graph re-runs `planContent` on the SAME cached plan, a no-op). So the
 *     honest terminal is to ship the best candidate flagged after the first detection rather
 *     than burn the whole iteration budget (D17 rationale; the LLM planner also avoids this by
 *     packing into enough screens). Fix the allocation upstream (raise `screens`).
 *  2. a CRITICAL, deterministically-UNFIXABLE finding (e.g. a missing required binding) →
 *     re-paint. A repair pass mechanically can't mend it, so it must outrank the mechanical-fix
 *     rule below — otherwise a co-occurring cosmetic FIXABLE finding wins repair and the loop
 *     budget dies polishing cosmetics on a content-broken board that never gets re-painted.
 *  3. a deterministically-fixable mechanical finding → repair (cheap/free, never the
 *     painter — §5.6);
 *  4. any other actionable finding → re-paint (minimal-change-first default — §10.6).
 * No actionable findings (or budget exhausted) → freeze (handled by the evaluator).
 */
export const routingRulesSchema = z.object({
  rules: z.array(routingRuleSchema).default([
    {
      id: "structural-capacity-to-freeze",
      when: { kindAnyOf: ["overflow-capacity"] },
      route: "freeze",
      priority: 100,
    },
    {
      id: "critical-unfixable-to-repaint",
      when: { minSeverity: "critical", deterministicallyFixable: false },
      route: "paint",
      priority: 95,
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
