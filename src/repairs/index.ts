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
  const contrastFindings = findings.filter(
    (f) => f.kind === FindingKind.Contrast && f.deterministicallyFixable && f.region,
  );
  if (contrastFindings.length === 0) {
    return { html, note: "no deterministic repair applicable", applied: false };
  }

  const rules: string[] = [];
  for (const finding of contrastFindings) {
    const bg = rgbaFromData(finding.data?.["bg"]);
    if (!bg) continue;
    const tokenName = chooseAccessibleColor(bg, theme);
    rules.push(`${escapeForStyle(finding.region!)}{color:var(--color-${tokenName}) !important;}`);
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
    (f) => f.kind === FindingKind.Contrast && f.deterministicallyFixable && Boolean(f.region),
  );
}
