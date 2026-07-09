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
 * (e.g. `[data-item-id=…] [data-bind=price]`, `.price`), OR an element-precise STRUCTURAL PATH — a
 * child-combinator / `nth-of-type` chain the sampler emits for text OUTSIDE an item card
 * (e.g. `header > span:nth-of-type(2)`, `body > div > p`). What we reject is a BARE tag like
 * `span`/`div`: recolouring it with `!important` would repaint every such element on the page and
 * wreck contrast everywhere — the invisible-text failure (fg==bg, ref just "span") that motivated
 * this guard, which the path ref now makes repairable.
 */
function isScopableSelector(selector: string): boolean {
  if (/[.#[]/.test(selector)) return true;
  return /\s>\s|:nth-of-type\(|:nth-child\(/.test(selector);
}

/**
 * A region that is EXACTLY a bare item-card container (`[data-item-id="X"]`) with no descendant
 * part. A card is a MIXED-BACKGROUND surface — a light pill/label sits over the dark card body, so
 * the sampler picks one face's background. A single-token recolour scoped to the whole card (`sel *`)
 * fixes that face and BREAKS the sibling on the opposite background; the next repair flips the token
 * and re-breaks the first — the loop oscillates and ships an unreadable board. Such findings are left
 * NOT deterministically fixable so routing escalates to re-paint (critical-unfixable → paint). The
 * in-browser sampler now emits an ELEMENT-PRECISE ref (`[data-item-id="X"] h3`) for card text without
 * a `data-bind`, so a genuinely single-element failure stays fixable — only the ambiguous bare
 * container hits this guard.
 */
function isBareItemCard(selector: string): boolean {
  return /^\s*\[data-item-id="[^"]*"\]\s*$/.test(selector);
}

/**
 * Whether a contrast finding can actually be fixed by a deterministic token swap: the region
 * must be safely scopable, NOT a bare (mixed-background) item card, AND some theme colour token must
 * clear the required ratio over the sampled background. When the text sits on a busy photo (mid-tone
 * bg) no token reaches 4.5:1, so a colour swap is futile — such findings must re-paint (add a scrim),
 * not loop on repair.
 */
export function contrastIsFixable(finding: QaFinding, theme: ResolvedTheme): boolean {
  if (finding.kind !== FindingKind.Contrast) return false;
  if (!finding.region || !isScopableSelector(finding.region)) return false;
  if (isBareItemCard(finding.region)) return false;
  const bg = rgbaFromData(finding.data?.["bg"]);
  if (!bg) return false;
  const required = typeof finding.data?.["required"] === "number" ? finding.data["required"] : 4.5;
  return bestTokenRatio(bg, theme) >= required;
}

function escapeForStyle(selector: string): string {
  // Selectors come from the browser as CSS; strip anything that could break out of the rule (`{`,
  // `}`, and `<` — which would let a `</style>` escape). The `>` CHILD COMBINATOR is kept: it is safe
  // inside a `<style>` rule and load-bearing for the element-precise path refs (`header > span…`) the
  // sampler now emits for text outside item cards — stripping it would silently widen the scope.
  return selector.replace(/[{}<]/g, "");
}

/** Insert a prebuilt `<style>` block into the document (before `</head>`, else `</body>`, else
 * appended to the fragment — the RAW painter markup has neither, so the block lands at the end). */
function injectBlock(html: string, block: string): string {
  if (html.includes("</head>")) return html.replace("</head>", `${block}</head>`);
  if (html.includes("</body>")) return html.replace("</body>", `${block}</body>`);
  return html + block;
}

const CONTRAST_BLOCK_RE = /<style data-repair="contrast"[^>]*>([\s\S]*?)<\/style>/;

/** The WCAG contrast token-swap (the D13 canonical repair). Only acts on findings a token swap can
 * genuinely fix on a safely-scopable, element-precise selector — generic selectors (bare `span`), a
 * bare mixed-background item card, or text on a photo (no token clears the ratio) are left for
 * re-paint (a global/whole-card `!important` recolour would wreck the board). Emits
 * `var(--color-<token>)`, never a raw hex, so the override passes token-lint.
 *
 * IDEMPOTENT + BOUNDED: a repair pass runs on the PREVIOUSLY-repaired HTML (repairNode threads its
 * output back into `state.html`), so it MERGES into the single existing `data-repair="contrast"`
 * block rather than appending a second one — appending let a later block silently override an
 * earlier pass's still-needed fix and grew the markup unboundedly. A selector already present in the
 * prior block is left untouched (first fix wins → convergence, not oscillation); only new selectors
 * are added. */
function applyContrastRepair(
  html: string,
  findings: readonly QaFinding[],
  theme: ResolvedTheme,
): DeterministicRepairResult {
  const contrastFindings = findings.filter((f) => contrastIsFixable(f, theme));
  if (contrastFindings.length === 0) return { html, note: "", applied: false };

  const existing = CONTRAST_BLOCK_RE.exec(html);
  const priorCss = existing?.[1] ?? "";
  const rules: string[] = [];
  const seen = new Set<string>();
  for (const finding of contrastFindings) {
    const bg = rgbaFromData(finding.data?.["bg"]);
    if (!bg) continue;
    const sel = escapeForStyle(finding.region!);
    if (seen.has(sel)) continue;
    seen.add(sel);
    // Keep an earlier pass's fix for this selector: a prior block already recolours it (first fix
    // wins). Re-emitting would either duplicate the rule or, on the merge, drop it — both regress.
    if (priorCss.includes(`${sel},${sel} *{`)) continue;
    const tokenName = chooseAccessibleColor(bg, theme);
    // Cover the region AND its descendants: when the finding's region is a wrapper (a `data-bind`
    // element whose failing text is a child with its own colour utility), a rule on the wrapper
    // alone won't reach the child — a parent's `!important` colour does not override a child's
    // own `color` declaration via inheritance. The `<sel> *` arm forces it on descendants too. The
    // ref is element-precise now (not a bare card), so `*` reaches only THIS element's subtree.
    rules.push(`${sel},${sel} *{color:var(--color-${tokenName}) !important;}`);
  }
  if (rules.length === 0) return { html, note: "", applied: false };

  const block = `<style data-repair="contrast">${priorCss}${rules.join("")}</style>`;
  const next = existing ? html.replace(CONTRAST_BLOCK_RE, block) : injectBlock(html, block);
  // Honesty guard (D65): never claim `applied` on an unchanged document (mirrors the overflow path).
  if (next === html) return { html, note: "", applied: false };
  return {
    html: next,
    note: `swapped contrast colour for ${rules.length} region(s)`,
    applied: true,
  };
}

const FIT_BLOCK_RE = /<style data-repair="fit"[^>]*>[\s\S]*?<\/style>/;

/** The absolute fit factor a shrinkable overflow finding asks for, or null when the finding is not
 * a deterministically-fixable overflow. Read straight off the finding — {@link checkOverflow}
 * computed it under the legibility + min-factor guards, so the repair stays a pure function of the
 * finding (mirroring how the contrast repair reads its sampled `bg`). */
function overflowShrinkFactor(finding: QaFinding): number | null {
  if (finding.kind !== FindingKind.Overflow || finding.deterministicallyFixable !== true) {
    return null;
  }
  const f = finding.data?.["shrinkFactor"];
  return typeof f === "number" && f > 0 && f < 1 ? f : null;
}

/**
 * Shrink-to-fit overflow repair (D31): scale the single painter root down by the computed fit factor
 * so an overflowing board fits its viewport — deterministically, without a re-paint (an LLM asked to
 * "fix overflow" repaints and overflows again). The injected block is
 * `html,body{height:100%;overflow:hidden;}body>*{transform:scale(f);transform-origin:top center;}`.
 *
 * WHY THE `html,body` CLAMP: a CSS `transform` changes an element's PAINT, not its layout box, so the
 * painter root's UNtransformed `min-h-screen` height still sets body height — and therefore
 * `documentElement.scrollHeight`, the exact metric {@link checkOverflow} reads. Without the clamp the
 * scaled board renders smaller but the overflow finding re-fires with identical numbers (the repaired
 * candidate never beats `best`, so it ships unrepaired). `overflow:hidden` on a `height:100%` html+body
 * makes `scrollHeight` read the transformed (clamped) box instead — repro-verified to zero the overshoot
 * at the reported factors. `transform-origin: top center` splits the residual side band from the scale
 * symmetrically so it reads as left/right margins, not a dead flank (`top left` pooled it all on the
 * right). The scale is aspect-preserving (no photo distortion).
 *
 * IDEMPOTENT + BOUNDED: it REPLACES any prior `data-repair="fit"` block instead of stacking a second
 * transform (a duplicate rule can't compound), and `f` arrives pre-clamped from the check (never
 * below the config `minShrinkFactor`/legibility floor — sub-0.9 trims escalate to re-paint). token-lint
 * clean: a unitless `scale()`, a percentage height, and keyword `overflow`/origin carry no raw hex/px,
 * so re-lint of the RAW markup stays green.
 */
function applyOverflowRepair(
  html: string,
  findings: readonly QaFinding[],
): DeterministicRepairResult {
  const factors = findings.map(overflowShrinkFactor).filter((f): f is number => f !== null);
  if (factors.length === 0) return { html, note: "", applied: false };
  const factor = Math.min(...factors); // the tightest fit demanded by any overflow finding
  const block =
    `<style data-repair="fit">html,body{height:100%;overflow:hidden;}` +
    `body>*{transform:scale(${factor});transform-origin:top center;}</style>`;
  const next = FIT_BLOCK_RE.test(html)
    ? html.replace(FIT_BLOCK_RE, block)
    : injectBlock(html, block);
  // Honesty (D65): a re-repair on already-shrunk markup REPLACES the fit block with a byte-identical
  // one — no change. Reporting `applied:true` on an unchanged document is what silently looped the
  // repair path ("deterministic repair applied", output identical, forever). Report no-change so the
  // caller (repairNode) can flag no-progress and the router escalates to a re-paint.
  if (next === html) return { html, note: "", applied: false };
  return { html: next, note: `shrank content to fit (×${factor})`, applied: true };
}

/**
 * Apply every deterministic repair that matches the given findings (D13). Cheap/free mechanical
 * fixes the router prefers over the painter (§5.6): a WCAG contrast token-swap and an overflow
 * shrink-to-fit (D31). Steps are threaded sequentially over the HTML so a board with both a contrast
 * and an overflow finding is fixed in one repair pass.
 */
export function applyDeterministicRepairs(
  html: string,
  findings: readonly QaFinding[],
  theme: ResolvedTheme,
): DeterministicRepairResult {
  let current = html;
  const notes: string[] = [];

  const contrast = applyContrastRepair(current, findings, theme);
  if (contrast.applied) {
    current = contrast.html;
    notes.push(contrast.note);
  }
  const overflow = applyOverflowRepair(current, findings);
  if (overflow.applied) {
    current = overflow.html;
    notes.push(overflow.note);
  }

  if (notes.length === 0)
    return { html, note: "no deterministic repair applicable", applied: false };
  // Final honesty guard (D65): if every sub-repair together left the markup byte-identical, report
  // no-change — an "applied" flag on unchanged HTML is what silently looped the repair path.
  if (current === html)
    return { html, note: "no deterministic repair changed the markup", applied: false };
  return { html: current, note: notes.join("; "), applied: true };
}

/** Whether any finding can be fixed deterministically (used by the repair node, D13). */
export function hasDeterministicRepair(findings: readonly QaFinding[]): boolean {
  return findings.some(
    (f) =>
      (f.kind === FindingKind.Contrast &&
        f.deterministicallyFixable &&
        Boolean(f.region) &&
        isScopableSelector(f.region ?? "")) ||
      overflowShrinkFactor(f) !== null,
  );
}
