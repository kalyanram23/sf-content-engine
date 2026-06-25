import type {
  CanonicalItem,
  GenerateConstraints,
  PlanScreen,
  QaFinding,
  ResolvedTheme,
} from "../domain/types";

export interface PaintRequest {
  /** The plan slice for this screen (content allocation + representation hints). */
  planScreen: PlanScreen;
  /** The canonical items referenced by this screen, resolved from ids. */
  items: CanonicalItem[];
  theme: ResolvedTheme;
  constraints: GenerateConstraints;
  /**
   * On a re-paint, the previous HTML and the findings to act on. The painter should make
   * the minimal change that resolves the findings (minimal-change-first, §10.6).
   */
  previousHtml?: string;
  findings?: QaFinding[];
}

/**
 * The "free paint" generator (spec §5.2): emits a bespoke, self-contained-ready HTML+JS
 * screen in Tailwind utility classes with `data-motion` and `data-item-id`/`data-bind`
 * hooks baked in. Returns RAW HTML; the Packager compiles/inlines it (D4).
 */
export interface Painter {
  paint(request: PaintRequest): Promise<string>;
}
