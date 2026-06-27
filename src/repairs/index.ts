import type { QaFinding, ResolvedTheme } from "../domain/types";
import type { Rgba } from "../ports/browser";
import { parseColor } from "../qa/colors";
import { contrastRatio } from "../qa/contrast";
import { FindingKind } from "../qa/finding";

/**
 * Pure deterministic repairs (D13) — no I/O, fully testable. These are the cheap/free
 * mechanical fixes the router prefers over the painter (§5.6). v1 implements the spec's
 * canonical example: a WCAG contrast token-swap. The repair appends a scoped, `!important`
 * override stylesheet keyed by the finding's region selector, referencing a THEME TOKEN var
 * (`var(--color-<name>)`, never a raw hex — so it stays on the rails and passes token-lint).
 * Packagers expose colour tokens as `--color-<name>` (Tailwind v4 convention).
 */

export interface DeterministicRepairResult {
  html: string;
  note: string;
  /** True when at least one finding was repaired. */
  applied: boolean;
}

function rgbaFromData(value: unknown): Rgba | null {
  if (typeof value !== "object" || value === null) return null;
  const v = value as Record<string, unknown>;
  if (typeof v["r"] === "number" && typeof v["g"] === "number" && typeof v["b"] === "number") {
    return { r: v["r"], g: v["g"], b: v["b"], a: typeof v["a"] === "number" ? v["a"] : 1 };
  }
  return null;
}

/**
 * Pick the NAME of the theme colour token with the best contrast over `bg`. Returning a
 * token name (not a hex) keeps the repair on the rails: the override references
 * `var(--color-<name>)`, which token-lint accepts and the packaged CSS resolves.
 */
export function chooseAccessibleColor(bg: Rgba, theme: ResolvedTheme): string {
  let best: { name: string; ratio: number } | null = null;
  for (const [name, value] of Object.entries(theme.tokens.colors)) {
    const rgba = parseColor(value);
    if (!rgba) continue;
    const ratio = contrastRatio(rgba, bg);
    if (!best || ratio > best.ratio) best = { name, ratio };
  }
  // Theme presets always carry colour tokens; fall back to the text token defensively.
  return best?.name ?? "text";
}

/** The best contrast any theme colour token achieves over `bg`. */
function bestTokenRatio(bg: Rgba, theme: ResolvedTheme): number {
  let best = 0;
  for (const value of Object.values(theme.tokens.colors)) {
    const rgba = parseColor(value);
    if (!rgba) continue;
    const ratio = contrastRatio(rgba, bg);
    if (ratio > best) best = ratio;
  }
  return best;
}

/**
 * A selector we can SAFELY scope a colour override to: anchored by a class, id, or attribute
 * (e.g. `[data-item-id=…] [data-bind=price]`, `.price`), NOT a bare tag like `span`/`div`.
 * Recolouring a bare tag with `!important` would repaint every such element on the page and
 * wreck contrast everywhere — exactly the failure that motivated this guard.
 */
function isScopableSelector(selector: string): boolean {
  return /[.#[]/.test(selector);
}

/**
 * Whether a contrast finding can actually be fixed by a deterministic token swap: the region
 * must be safely scopable AND some theme colour token must clear the required ratio over the
 * sampled background. When the text sits on a busy photo (mid-tone bg) no token reaches 4.5:1,
 * so a colour swap is futile — such findings must re-paint (add a scrim), not loop on repair.
 */
export function contrastIsFixable(finding: QaFinding, theme: ResolvedTheme): boolean {
  if (finding.kind !== FindingKind.Contrast) return false;
  if (!finding.region || !isScopableSelector(finding.region)) return false;
  const bg = rgbaFromData(finding.data?.["bg"]);
  if (!bg) return false;
  const required = typeof finding.data?.["required"] === "number" ? finding.data["required"] : 4.5;
  return bestTokenRatio(bg, theme) >= required;
}

function escapeForStyle(selector: string): string {
  // Selectors come from the browser as CSS; strip anything that could break out of the rule.
  return selector.replace(/[{}<>]/g, "");
}

function injectStyle(html: string, css: string): string {
  const block = `<style data-repair="contrast">${css}</style>`;
  if (html.includes("</head>")) return html.replace("</head>", `${block}</head>`);
  if (html.includes("</body>")) return html.replace("</body>", `${block}</body>`);
  return html + block;
}

/** Apply every deterministic repair that matches the given findings. */
export function applyDeterministicRepairs(
  html: string,
  findings: readonly QaFinding[],
  theme: ResolvedTheme,
): DeterministicRepairResult {
  // Only act on findings a token swap can genuinely fix on a safely-scopable selector. Generic
  // selectors (bare `span`) or text on a photo (no token clears the ratio) are NOT fixed here —
  // they route to re-paint instead (a global `!important` recolour would wreck the board).
  const contrastFindings = findings.filter((f) => contrastIsFixable(f, theme));
  if (contrastFindings.length === 0) {
    return { html, note: "no deterministic repair applicable", applied: false };
  }

  const rules: string[] = [];
  const seen = new Set<string>();
  for (const finding of contrastFindings) {
    const bg = rgbaFromData(finding.data?.["bg"]);
    if (!bg) continue;
    const sel = escapeForStyle(finding.region!);
    const tokenName = chooseAccessibleColor(bg, theme);
    const key = `${sel}|${tokenName}`;
    if (seen.has(key)) continue;
    seen.add(key);
    // Cover the region AND its descendants: when the finding's region is a container (an item
    // card whose failing text is a child with its own colour utility), a rule on the container
    // alone won't reach the child — a parent's `!important` colour does not override a child's
    // own `color` declaration via inheritance. The `<sel> *` arm forces it on descendants too.
    rules.push(`${sel},${sel} *{color:var(--color-${tokenName}) !important;}`);
  }

  if (rules.length === 0) {
    return { html, note: "contrast findings lacked the data needed to repair", applied: false };
  }

  return {
    html: injectStyle(html, rules.join("")),
    note: `swapped contrast colour for ${rules.length} region(s)`,
    applied: true,
  };
}

/** Whether any finding can be fixed deterministically (used by the repair node, D13). */
export function hasDeterministicRepair(findings: readonly QaFinding[]): boolean {
  return findings.some(
    (f) =>
      f.kind === FindingKind.Contrast &&
      f.deterministicallyFixable &&
      Boolean(f.region) &&
      isScopableSelector(f.region ?? ""),
  );
}
