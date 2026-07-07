/**
 * Code graders — deterministic pass/fail checks over what the engine actually shipped.
 * These are INDEPENDENT re-checks: they read only the plan/HTML/report/poster outputs,
 * never the engine's internals, so a bug in the engine's own bookkeeping can't hide itself.
 */
import type {
  CanonicalItem,
  PlanScreen,
  Poster,
  QaScreenReport,
  Severity,
  ThinPlan,
  VisionRubricConfig,
} from "../../src/index";
import { isMatrixBoard } from "../../src/planning/layout-strategy";
import { scoreScreen } from "../../src/qa/scoring";

export interface GraderResult {
  id: string;
  pass: boolean;
  /** One plain sentence: what was checked and (on failure) what went wrong. */
  detail: string;
}

/* ------------------------------------------------------------------ plan-level graders */

/** Item-id → list of board indexes it appears on (via plan sections). */
function itemPlacements(plan: ThinPlan): Map<string, number[]> {
  const placements = new Map<string, number[]>();
  plan.screens.forEach((screen, boardIndex) => {
    for (const section of screen.sections) {
      for (const id of section.items) {
        const seen = placements.get(id) ?? [];
        seen.push(boardIndex);
        placements.set(id, seen);
      }
    }
  });
  return placements;
}

/**
 * Every menu item appears on exactly one board — nothing dropped, nothing duplicated.
 * This is the engine's core promise ("deterministic coverage"), re-verified from the outside.
 */
export function gradePlanCoverage(plan: ThinPlan, menu: readonly CanonicalItem[]): GraderResult {
  const placements = itemPlacements(plan);
  const missing = menu.filter((item) => !placements.has(item.id)).map((item) => item.id);
  const duplicated = [...placements.entries()]
    .filter(([, boards]) => boards.length > 1)
    .map(([id]) => id);
  const unknown = [...placements.keys()].filter((id) => !menu.some((item) => item.id === id));
  const pass = missing.length === 0 && duplicated.length === 0 && unknown.length === 0;
  const detail = pass
    ? `all ${menu.length} items placed exactly once`
    : `missing=${missing.length} duplicated=${duplicated.length} invented=${unknown.length}` +
      (missing.length > 0 ? ` (e.g. ${missing.slice(0, 3).join(", ")})` : "");
  return { id: "plan-coverage", pass, detail };
}

/** No category is split across boards (categories are atomic, D25). */
export function gradeCategoryAtomic(plan: ThinPlan, menu: readonly CanonicalItem[]): GraderResult {
  const placements = itemPlacements(plan);
  const boardsByCategory = new Map<string, Set<number>>();
  for (const item of menu) {
    if (item.category === undefined) continue;
    const boards = placements.get(item.id) ?? [];
    const set = boardsByCategory.get(item.category) ?? new Set<number>();
    for (const b of boards) set.add(b);
    boardsByCategory.set(item.category, set);
  }
  const split = [...boardsByCategory.entries()]
    .filter(([, boards]) => boards.size > 1)
    .map(([category]) => category);
  return {
    id: "category-atomic",
    pass: split.length === 0,
    detail:
      split.length === 0
        ? `no category split across boards (${boardsByCategory.size} categories)`
        : `split categories: ${split.slice(0, 5).join(", ")}`,
  };
}

/** Exact screens mode (D26): asked-for board count is honored, capped by the category count. */
export function gradeScreensExact(
  plan: ThinPlan,
  menu: readonly CanonicalItem[],
  requested: number,
): GraderResult {
  const categories = new Set(menu.map((item) => item.category ?? "(uncategorized)"));
  const expected = Math.min(requested, categories.size);
  const actual = plan.screens.length;
  return {
    id: "screens-exact",
    pass: actual === expected,
    detail:
      actual === expected
        ? `${actual} board(s) as expected (requested ${requested}, ${categories.size} categories)`
        : `expected ${expected} board(s) (requested ${requested}, ${categories.size} categories) but plan has ${actual}`,
  };
}

/** How evenly items are spread across boards — reported as a metric, not pass/fail. */
export function balanceSpread(plan: ThinPlan): {
  perBoard: number[];
  min: number;
  max: number;
} {
  const perBoard = plan.screens.map((screen) =>
    screen.sections.reduce((sum, section) => sum + section.items.length, 0),
  );
  return {
    perBoard,
    min: Math.min(...perBoard),
    max: Math.max(...perBoard),
  };
}

/* ------------------------------------------------------------------ board-level graders */

/** The engine's own QA verdict: did this board pass the generator–critic loop? */
export function gradeQaPassed(report: QaScreenReport): GraderResult {
  return {
    id: "qa-passed",
    pass: report.passed,
    detail: report.passed
      ? `passed QA in ${report.iterations} iteration(s)`
      : `shipped ${report.flagged ? "FLAGGED" : "unpassed"} after ${report.iterations} iteration(s): ` +
        summarizeFindings(report),
  };
}

/** Every item planned onto this board is actually present in the shipped HTML. */
export function gradeBindingsInHtml(html: string, itemIds: readonly string[]): GraderResult {
  const missing = itemIds.filter((id) => !html.includes(`data-item-id="${id}"`));
  return {
    id: "items-in-html",
    pass: missing.length === 0,
    detail:
      missing.length === 0
        ? `all ${itemIds.length} items present in the HTML`
        : `${missing.length}/${itemIds.length} items missing from the HTML (e.g. ${missing
            .slice(0, 3)
            .join(", ")})`,
  };
}

/** HTML-attribute-escape a section title so it matches the value as it appears in shipped markup. */
function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Every menu category on the board has a visual anchor (the category-images requirement), re-verified
 * from the shipped HTML's `data-image-slot` markers:
 *   • comfortable, non-matrix board: EVERY section (= category) must appear as a `data-image-slot`
 *     value — a real photo panel or a deliberate food-icon panel.
 *   • dense/packed or matrix / absent-tier board: ONE shared slot suffices, and is required only when
 *     the board actually has photo items (a photo-less dense board legitimately carries no slot).
 */
export function gradeCategoryImages(
  html: string,
  planScreen: PlanScreen,
  menu: readonly CanonicalItem[],
): GraderResult {
  const slotValues = new Set(
    [...html.matchAll(/data-image-slot\s*=\s*"([^"]*)"/g)].map((m) => m[1] ?? ""),
  );
  const plannedIds = new Set(planScreen.sections.flatMap((s) => s.items));
  const boardHasPhotos = menu.some((i) => plannedIds.has(i.id) && (i.images?.length ?? 0) > 0);
  const perCategory = planScreen.densityTier === "comfortable" && !isMatrixBoard(planScreen);

  if (perCategory) {
    const missing = planScreen.sections
      .map((s) => s.title)
      .filter((title) => !slotValues.has(escapeAttr(title)));
    return {
      id: "category-images",
      pass: missing.length === 0,
      detail:
        missing.length === 0
          ? `all ${planScreen.sections.length} categories carry a data-image-slot anchor`
          : `${missing.length}/${planScreen.sections.length} category slot(s) missing: ${missing
              .slice(0, 3)
              .join(", ")}`,
    };
  }

  const pass = !boardHasPhotos || slotValues.size > 0;
  return {
    id: "category-images",
    pass,
    detail: pass
      ? boardHasPhotos
        ? `shared image slot present (${slotValues.size} data-image-slot element(s))`
        : "no photo items on this board — no image slot required"
      : "board has photo items but rendered no data-image-slot element",
  };
}

/** The shipped HTML loads nothing from the network (safe to run on an offline screen). */
export function gradeSelfContained(html: string): GraderResult {
  const external = html.match(/(?:src|href)\s*=\s*["']https?:|url\(\s*["']?https?:/gi) ?? [];
  return {
    id: "self-contained",
    pass: external.length === 0,
    detail:
      external.length === 0
        ? "no external network references"
        : `${external.length} external reference(s) found`,
  };
}

/** The poster image matches the requested screen geometry. */
export function gradePosterGeometry(
  poster: Poster | undefined,
  viewport: { width: number; height: number },
): GraderResult {
  if (!poster || poster.pngBase64.length === 0) {
    return { id: "poster", pass: false, detail: "no poster PNG produced" };
  }
  const pass = poster.width === viewport.width && poster.height === viewport.height;
  return {
    id: "poster",
    pass,
    detail: pass
      ? `poster ${poster.width}×${poster.height} matches viewport`
      : `poster ${poster.width}×${poster.height} != viewport ${viewport.width}×${viewport.height}`,
  };
}

/**
 * Recompute the score from the shipped findings and confirm it agrees with the report's
 * pass/fail — catches the report and the scorer drifting apart.
 */
export function gradeReportConsistency(
  report: QaScreenReport,
  rubric: VisionRubricConfig,
  blockingSeverity: Severity,
): { grader: GraderResult; rubricScore: number; penalty: number } {
  const recomputed = scoreScreen(report.findings, rubric, blockingSeverity);
  const pass = recomputed.passed === report.passed;
  return {
    grader: {
      id: "report-consistency",
      pass,
      detail: pass
        ? `recomputed verdict agrees (rubric ${recomputed.rubricScore.toFixed(2)}, penalty ${recomputed.penalty})`
        : `recomputed passed=${String(recomputed.passed)} but report says passed=${String(report.passed)}`,
    },
    rubricScore: recomputed.rubricScore,
    penalty: recomputed.penalty,
  };
}

/** Short "kind(severity)×n" summary of a report's findings, for one-line printouts. */
export function summarizeFindings(report: QaScreenReport): string {
  if (report.findings.length === 0) return "no findings";
  const counts = new Map<string, number>();
  for (const finding of report.findings) {
    const key = `${finding.kind}(${finding.severity})`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([key, n]) => (n > 1 ? `${key}×${n}` : key)).join(", ");
}
