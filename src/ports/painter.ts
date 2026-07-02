import type {
  BrandInput,
  CanonicalItem,
  GenerateConstraints,
  LayoutBlueprint,
  PlanScreen,
  QaFinding,
  ResolvedTheme,
} from "../domain/types";
import type { RequestCorrelation } from "./correlation";

export interface PaintRequest {
  /** The plan slice for this screen (content allocation + representation hints). */
  planScreen: PlanScreen;
  /** The canonical items referenced by this screen, resolved from ids. */
  items: CanonicalItem[];
  theme: ResolvedTheme;
  constraints: GenerateConstraints;
  /** The exact pixel canvas the screen is rendered + QA'd at (derived from the aspect). */
  viewport?: { width: number; height: number };
  /**
   * The layout blueprint selected for this board (config `layouts`, D17). The painter renders
   * its strategy + FIXED/FREE contract as the board's layout rails. Absent → the painter
   * derives the legacy strategy from the plan.
   */
  blueprint?: LayoutBlueprint;
  /**
   * Board-set anti-patterns (config data, `config.painter.antiPatterns`) — known LLM design
   * failure modes the painter must avoid; the vision critic sees the same list.
   */
  antiPatterns?: readonly string[];
  /**
   * On a re-paint, the previous HTML and the findings to act on. The painter should make
   * the minimal change that resolves the findings (minimal-change-first, §10.6).
   */
  previousHtml?: string;
  findings?: QaFinding[];
  /** Observability correlation for this call (run/board/iteration), threaded to OpenRouter Broadcast. */
  correlation?: RequestCorrelation;
  /** Optional brand content (logo + name/tagline). Present → the painter renders a header band;
   * the logo uses the `data-brand-logo` no-src placeholder scheme (packager inlines it). */
  brand?: BrandInput;
}

/**
 * The "free paint" generator (spec §5.2): emits a bespoke, self-contained-ready HTML+JS
 * screen in Tailwind utility classes with `data-motion` and `data-item-id`/`data-bind`
 * hooks baked in. Returns RAW HTML; the Packager compiles/inlines it (D4).
 */
export interface Painter {
  paint(request: PaintRequest): Promise<string>;
}
