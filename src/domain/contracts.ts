import { z } from "zod";

import { severitySchema, thinPlanSchema } from "./schemas";

/**
 * Strict LLM request/response contracts. These are SEPARATE from EngineState and the
 * domain value objects (DECISIONS D2): each describes one model response and must be
 * convertible to a strict JSON Schema (`additionalProperties:false`) for OpenRouter
 * structured outputs (D11). Keep them free of unions/refinements that strict mode can't
 * express.
 */

/** What the planner LLM returns — the thin plan (spec §5.4). */
export const planResponseSchema = thinPlanSchema;
export type PlanResponse = z.infer<typeof planResponseSchema>;

/**
 * The coverage planner's CATEGORY-LEVEL intent (D-coverage). The LLM emits an ordered list of
 * blocks — grouping, representation, order, and combined-category matrices — but NOT item ids.
 * Deterministic code (`src/planning/coverage.ts`) expands each block to the real item ids,
 * guarantees 100% menu coverage, and packs blocks into the requested screen count. Keeping the
 * LLM output small + id-free is what makes it reliable. All fields required for strict mode (D11);
 * `layoutHint` is "" when there's no special direction.
 */
export const planBlockSchema = z.object({
  /** Section heading the painter shows (e.g. "Biryani & Pulav", "Veg Curries"). */
  title: z.string().min(1),
  /** One or more menu category names whose items fill this block (>1 = a combined/matrix block). */
  categories: z.array(z.string().min(1)).min(1),
  /**
   * The planner-facing representation enum (E1) — DELIBERATELY narrower than the internal
   * `representationSchema`: it omits "variant-rows" because the id-free menu digest carries no
   * variant signal, so a planner choice of "variant-rows" would be uninformed guessing. The
   * internal enum keeps "variant-rows" for `checkRepresentations` + hand-authored plans.
   */
  representation: z.enum(["matrix", "grid", "list"]),
  /** Free-text painter direction (e.g. the price-table description); "" if none. */
  layoutHint: z.string(),
});
export type PlanBlock = z.infer<typeof planBlockSchema>;

export const planLayoutSchema = z.object({
  blocks: z.array(planBlockSchema).min(1),
});
export type PlanLayout = z.infer<typeof planLayoutSchema>;

/** A single critic finding, keyed to a rubric dimension id (spec §5.6 vision pass). */
export const critiqueFindingSchema = z.object({
  /** Rubric dimension id (e.g. "balance", "hierarchy"). */
  dimension: z.string().min(1),
  severity: severitySchema,
  /** The critic's layout-vs-content hint (spec §5.6). */
  tag: z.enum(["layout", "content"]),
  region: z.string(),
  message: z.string(),
});
export type CritiqueFinding = z.infer<typeof critiqueFindingSchema>;

/** The vision critic's structured rubric response (spec §5.6). */
export const critiqueResponseSchema = z.object({
  findings: z.array(critiqueFindingSchema),
});
export type CritiqueResponse = z.infer<typeof critiqueResponseSchema>;

/** What an LLM-backed repair returns: the patched HTML only (D13). */
export const repairResponseSchema = z.object({
  html: z.string().min(1),
  note: z.string(),
});
export type RepairResponse = z.infer<typeof repairResponseSchema>;

/**
 * The composition contract (D71) — the ENGINE-OWNED abstract "order form" a composer LLM fills
 * against a closed component vocabulary. Deliberately theme-agnostic: the three block kinds are
 * the only structures ANY vocabulary must render; a theme decides how a block LOOKS, never what
 * blocks EXIST. Strict-mode shape (D11): flat object, `kind` enum, every field required — unused
 * fields carry ""/[] sentinels (the planBlockSchema precedent). The LLM decides JUDGMENT only
 * (order, grouping, photo picks, title); all arithmetic (sizes, columns, type scale) is the
 * deterministic layout engine's.
 */
export const compositionBlockSchema = z.object({
  /** Which abstract component this block renders. */
  kind: z.enum(["section", "group", "photoBand"]),
  /** kind "section": the exact section title to render full-width; "" otherwise. */
  section: z.string(),
  /** kind "group": 2–3 exact section titles side by side in one band; [] otherwise. */
  sections: z.array(z.string()),
  /** kind "photoBand": 3–12 item ids from the photo library; [] otherwise. */
  itemIds: z.array(z.string()),
});
export type CompositionBlock = z.infer<typeof compositionBlockSchema>;

/** What the composer LLM returns — board title + ordered body blocks (top to bottom). */
export const compositionResponseSchema = z.object({
  /** Short human masthead title (e.g. "Street & Sweets"). The one sanctioned invented-copy field. */
  title: z.string().min(1),
  blocks: z.array(compositionBlockSchema),
});
export type CompositionResponse = z.infer<typeof compositionResponseSchema>;
