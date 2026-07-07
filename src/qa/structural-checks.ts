import { type HTMLElement, parse } from "node-html-parser";

import type { QaConfig } from "../config/qa";
import type { TokenLintRules } from "../config/token-lint";
import type { CanonicalItem, PlanScreen, QaFinding, ResolvedTheme } from "../domain/types";
import { FindingKind, makeFinding } from "./finding";
import { checkCapacity, checkRepresentations } from "./representation";

/**
 * Pure structural checks over the LLM-authored / packaged HTML (D3). Parsed once with
 * node-html-parser (tiny, pure-JS). Covers the §5.5/§5.6 binding contract, the §5.2
 * token-lint + motion-vocab rails, and the §5.1 self-contained / no-baked-player contract.
 * The rendered DOM (BrowserPort) is the spec-compliant backstop on the live path; these
 * checks have adversarial malformed-HTML fixtures.
 */

export interface StructuralContext {
  /** The packaged, self-contained artifact (what ships) — checked for bindings/motion/etc. */
  html: string;
  /**
   * The raw, painter-authored markup (pre-compile). Token-lint runs HERE so raw hex/px in
   * the painter's classes are caught, not the legitimate hex in compiled CSS (D3/S7). Falls
   * back to `html` when omitted.
   */
  rawHtml?: string;
  planScreen: PlanScreen;
  items: CanonicalItem[];
  theme: ResolvedTheme;
  qa: QaConfig;
  tokenLint: TokenLintRules;
  /** True when the run supplied a brand logo — enables the brand-binding check. */
  brandLogoRequested?: boolean;
}

const DATA_URI = /^(data:|#|blob:)/i;
const HEX = /#[0-9a-fA-F]{3,8}\b/g;
const PX = /(-?\d*\.?\d+)px\b/g;
const URL_FN = /url\(\s*['"]?([^'")]+)['"]?\s*\)/gi;
const BAKED_PLAYER = [
  { re: /\blocation\.(href|assign|replace)\b/, what: "location navigation" },
  { re: /\bwindow\.location\b/, what: "window.location" },
  { re: /\bhistory\.(push|replace)State\b/, what: "history navigation" },
  { re: /\bwindow\.open\s*\(/, what: "window.open" },
];

function plannedSectionItemIds(plan: PlanScreen): string[] {
  const ids = new Set<string>();
  for (const section of plan.sections) for (const id of section.items) ids.add(id);
  return [...ids];
}

function numbersIn(text: string): number[] {
  return (text.match(/\d+(?:\.\d+)?/g) ?? []).map(Number);
}

/** The price values that should appear bound somewhere inside an item node, if any. */
function expectedPrices(item: CanonicalItem): number[] {
  const prices: number[] = [];
  if (item.price !== undefined) prices.push(item.price);
  for (const size of item.sizes ?? []) prices.push(size.price);
  for (const variant of item.variants ?? [])
    if (variant.price !== undefined) prices.push(variant.price);
  return prices;
}

function approxIncludes(haystack: number[], needle: number): boolean {
  return haystack.some((n) => Math.abs(n - needle) < 0.005);
}

/** §5.5/§5.6 binding contract: every planned item present + unique, required hooks exist, prices match. */
export function checkBindings(root: HTMLElement, ctx: StructuralContext): QaFinding[] {
  const findings: QaFinding[] = [];
  const itemsById = new Map(ctx.items.map((i) => [i.id, i]));
  const nodesById = new Map<string, HTMLElement[]>();
  for (const el of root.querySelectorAll("[data-item-id]")) {
    const id = el.getAttribute("data-item-id");
    if (!id) continue;
    const list = nodesById.get(id) ?? [];
    list.push(el);
    nodesById.set(id, list);
  }

  for (const id of plannedSectionItemIds(ctx.planScreen)) {
    const nodes = nodesById.get(id) ?? [];
    if (nodes.length === 0) {
      findings.push(
        makeFinding({
          kind: FindingKind.BindingMissing,
          source: "deterministic",
          severity: "critical",
          tag: "content",
          itemId: id,
          message: `Planned item "${id}" has no element with data-item-id="${id}".`,
        }),
      );
      continue;
    }
    if (nodes.length > 1) {
      findings.push(
        makeFinding({
          kind: FindingKind.BindingDuplicate,
          source: "deterministic",
          severity: "major",
          tag: "content",
          itemId: id,
          message: `Item "${id}" appears ${nodes.length} times; data-item-id must be unique.`,
          data: { count: nodes.length },
        }),
      );
    }

    const node = nodes[0]!;
    const item = itemsById.get(id);
    const prices = item ? expectedPrices(item) : [];

    for (const binding of ctx.qa.requiredBindings) {
      // "price" is only required for items that actually carry price data.
      if (binding === "price" && prices.length === 0) continue;
      const hooks = node.querySelectorAll(`[data-bind="${binding}"]`);
      if (hooks.length === 0) {
        findings.push(
          makeFinding({
            kind: FindingKind.BindingHookMissing,
            source: "deterministic",
            severity: "critical",
            tag: "content",
            itemId: id,
            message: `Item "${id}" is missing a data-bind="${binding}" hook (patcher contract).`,
            data: { binding },
          }),
        );
        continue;
      }
      if (binding === "price") {
        const bound = numbersIn(hooks.map((h) => h.text).join(" "));
        const missing = prices.filter((p) => !approxIncludes(bound, p));
        if (missing.length > 0) {
          findings.push(
            makeFinding({
              kind: FindingKind.BindingMismatch,
              source: "deterministic",
              severity: "major",
              tag: "content",
              itemId: id,
              message: `Item "${id}" price binding does not match source (missing ${missing.join(", ")}).`,
              data: { expected: prices, bound, missing },
            }),
          );
        }
      }
    }
  }
  return findings;
}

/** True when some `[data-bind="price"]` inside `node` renders non-whitespace text. A filled matrix
 * cell counts (it wraps the item id AND that same price span); an em-dash cell carries no
 * data-item-id, so it is never reached as an item node here. */
function hasRenderedPrice(node: HTMLElement): boolean {
  return node.querySelectorAll('[data-bind="price"]').some((span) => span.text.trim() !== "");
}

/**
 * Price-present check (product requirement "prices properly there"): every planned item whose SOURCE
 * data carries a price — base `price`, any `sizes[].price`, or a priced `variant` (the same
 * detection as {@link expectedPrices}, mirroring `menu-lint`) — must render a NON-EMPTY price inside
 * its `data-item-id` element: a `[data-bind="price"]` span with non-whitespace text (a filled matrix
 * cell is exactly this). Items with no source price (menu-lint hides these) are exempt, and a genuine
 * em-dash cell — no data-item-id — never fires. Distinct from the binding contract's number-matching:
 * this is the blunt "a price actually shipped" guarantee. A wholly-missing element is left to
 * {@link checkBindings} (binding-missing) so the two never double-report the same hole.
 */
export function checkPricePresent(root: HTMLElement, ctx: StructuralContext): QaFinding[] {
  const findings: QaFinding[] = [];
  const nodesById = new Map<string, HTMLElement[]>();
  for (const el of root.querySelectorAll("[data-item-id]")) {
    const id = el.getAttribute("data-item-id");
    if (!id) continue;
    const list = nodesById.get(id) ?? [];
    list.push(el);
    nodesById.set(id, list);
  }
  const itemsById = new Map(ctx.items.map((i) => [i.id, i]));

  for (const id of plannedSectionItemIds(ctx.planScreen)) {
    const item = itemsById.get(id);
    if (item === undefined || expectedPrices(item).length === 0) continue; // no source price → exempt
    const nodes = nodesById.get(id) ?? [];
    if (nodes.length === 0 || nodes.some(hasRenderedPrice)) continue; // missing element → checkBindings owns it
    findings.push(
      makeFinding({
        kind: "price-missing",
        source: "deterministic",
        severity: "major",
        tag: "content",
        itemId: id,
        message: `Planned item "${id}" has a price in the menu but renders no non-empty data-bind="price".`,
      }),
    );
  }
  return findings;
}

function lintCss(text: string, where: string, rules: TokenLintRules): QaFinding[] {
  const findings: QaFinding[] = [];
  if (!rules.allowRawHex) {
    for (const m of text.matchAll(HEX)) {
      findings.push(
        makeFinding({
          kind: FindingKind.TokenLint,
          source: "deterministic",
          severity: "major",
          tag: "mechanical",
          region: where,
          message: `Raw hex colour "${m[0]}" in ${where}; use a theme token.`,
          data: { value: m[0], where },
        }),
      );
    }
  }
  if (!rules.allowRawPx) {
    for (const m of text.matchAll(PX)) {
      const value = Number(m[1]);
      if (rules.allowedPxValues.includes(value)) continue;
      findings.push(
        makeFinding({
          kind: FindingKind.TokenLint,
          source: "deterministic",
          severity: "major",
          tag: "mechanical",
          region: where,
          message: `Raw px value "${m[0]}" in ${where}; use a spacing/size token.`,
          data: { value: m[0], where },
        }),
      );
    }
  }
  return findings;
}

/** True when `el` is, or is nested inside, an `aria-hidden="true"` SVG (painter decoration). */
function isDecorativeSvg(el: HTMLElement): boolean {
  let node: HTMLElement | null = el;
  while (node) {
    if (node.tagName?.toLowerCase() === "svg" && node.getAttribute("aria-hidden") === "true") {
      return true;
    }
    node = node.parentNode as HTMLElement | null;
  }
  return false;
}

/** §5.2 token-lint rail: reject raw hex/px in class arbitrary-values, inline style, and <style>. */
export function checkTokenLint(root: HTMLElement, ctx: StructuralContext): QaFinding[] {
  const findings: QaFinding[] = [];

  // Arbitrary-value Tailwind utilities: text-[#fff], p-[7px], etc.
  for (const el of root.querySelectorAll("[class]")) {
    const className = el.getAttribute("class") ?? "";
    for (const m of className.matchAll(/\[([^\]]+)\]/g)) {
      const inner = m[1] ?? "";
      findings.push(...lintCss(inner, `class "${m[0]}"`, ctx.tokenLint));
    }
  }
  // Inline style attributes. Decorative SVG (aria-hidden="true") legitimately needs raw px for
  // geometry/font-size (e.g. a giant "ghost word"), so exempt PX there; raw hex stays flagged
  // (decoration must still colour via theme tokens — see the SVG presentation-attr check below).
  const decorativePxRules: TokenLintRules = { ...ctx.tokenLint, allowRawPx: true };
  for (const el of root.querySelectorAll("[style]")) {
    const rules = isDecorativeSvg(el) ? decorativePxRules : ctx.tokenLint;
    findings.push(...lintCss(el.getAttribute("style") ?? "", "inline style", rules));
  }
  // <style> blocks.
  for (const el of root.querySelectorAll("style")) {
    findings.push(...lintCss(el.text, "<style> block", ctx.tokenLint));
  }
  // SVG presentation attributes (painter-authored decoration must use theme tokens, not raw hex):
  // fill="#fff" / stroke="#abc" / stop-color / flood-color. Use var(--color-*) or currentColor.
  for (const attr of ["fill", "stroke", "stop-color", "flood-color"]) {
    for (const el of root.querySelectorAll(`[${attr}]`)) {
      findings.push(...lintCss(el.getAttribute(attr) ?? "", `${attr} attribute`, ctx.tokenLint));
    }
  }

  // Dedupe identical (value, where) findings to avoid flooding the loop.
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${String(f.data?.["value"])}@${String(f.data?.["where"])}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** §5.2 motion rail: every data-motion value is in the theme vocab; runtime motion is inlined (D14). */
export function checkMotion(root: HTMLElement, ctx: StructuralContext): QaFinding[] {
  const findings: QaFinding[] = [];
  const vocab = new Map(ctx.theme.motion.map((m) => [m.name, m]));
  let usesRuntime = false;

  for (const el of root.querySelectorAll("[data-motion]")) {
    const name = el.getAttribute("data-motion") ?? "";
    const preset = vocab.get(name);
    if (!preset) {
      findings.push(
        makeFinding({
          kind: FindingKind.MotionVocab,
          source: "deterministic",
          severity: "major",
          tag: "mechanical",
          message: `Unknown data-motion="${name}"; not in the theme's motion vocabulary.`,
          data: { name, vocab: [...vocab.keys()] },
        }),
      );
      continue;
    }
    if (preset.kind === "runtime") usesRuntime = true;
  }

  // Orchestrated motion requires the inlined Motion runtime + glue to be self-contained (§5.1).
  if (usesRuntime && !root.querySelector("[data-motion-runtime]")) {
    findings.push(
      makeFinding({
        kind: FindingKind.MotionVocab,
        source: "deterministic",
        severity: "major",
        tag: "structural",
        message:
          "Runtime motion is used but the inlined Motion runtime/glue is missing (offline-unsafe).",
      }),
    );
  }
  return findings;
}

/** §5.1 self-contained + no-baked-player contract. */
export function checkSelfContained(root: HTMLElement, _ctx?: StructuralContext): QaFinding[] {
  const findings: QaFinding[] = [];

  for (const el of root.querySelectorAll("[src], [href], [srcset]")) {
    for (const attr of ["src", "href", "srcset"]) {
      const value = el.getAttribute(attr);
      if (value && value.trim() !== "" && !DATA_URI.test(value.trim())) {
        findings.push(
          makeFinding({
            kind: FindingKind.SelfContained,
            source: "deterministic",
            severity: "major",
            tag: "structural",
            message: `External reference ${attr}="${value}" breaks offline-safety; inline as a data-URI.`,
            data: { attr, value },
          }),
        );
      }
    }
  }

  // url() in inline styles + <style> blocks.
  const cssTexts = [
    ...root.querySelectorAll("[style]").map((el) => el.getAttribute("style") ?? ""),
    ...root.querySelectorAll("style").map((el) => el.text),
  ];
  for (const css of cssTexts) {
    for (const m of css.matchAll(URL_FN)) {
      const ref = (m[1] ?? "").trim();
      if (ref !== "" && !DATA_URI.test(ref)) {
        findings.push(
          makeFinding({
            kind: FindingKind.SelfContained,
            source: "deterministic",
            severity: "major",
            tag: "structural",
            message: `External url(${ref}) breaks offline-safety; inline as a data-URI.`,
            data: { value: ref },
          }),
        );
      }
    }
  }

  // No baked-in player / cross-screen navigation (§5.1).
  const hasMetaRefresh = root
    .querySelectorAll("meta")
    .some((m) => (m.getAttribute("http-equiv") ?? "").toLowerCase() === "refresh");
  if (hasMetaRefresh) {
    findings.push(
      makeFinding({
        kind: FindingKind.BakedPlayer,
        source: "deterministic",
        severity: "major",
        tag: "structural",
        message:
          "Screen contains a <meta refresh>; the engine never bakes in navigation/auto-advance.",
      }),
    );
  }
  const scriptText = root
    .querySelectorAll("script")
    .map((s) => s.text)
    .join("\n");
  for (const { re, what } of BAKED_PLAYER) {
    if (re.test(scriptText)) {
      findings.push(
        makeFinding({
          kind: FindingKind.BakedPlayer,
          source: "deterministic",
          severity: "major",
          tag: "structural",
          message: `Screen script uses ${what}; the engine never bakes in navigation/auto-advance.`,
          data: { what },
        }),
      );
    }
  }
  return findings;
}

/** Locate the `[data-matrix]` container holding this section's items; falls back to the root when
 * there is at most one matrix on the board (or none). */
function findMatrixContainer(root: HTMLElement, itemIds: Set<string>): HTMLElement {
  const containers = root.querySelectorAll("[data-matrix]");
  if (containers.length <= 1) return containers[0] ?? root;
  for (const container of containers) {
    for (const cell of container.querySelectorAll("[data-matrix-cell]")) {
      const id = cell.getAttribute("data-item-id");
      if (id !== undefined && itemIds.has(id)) return container;
    }
  }
  return containers[0] ?? root;
}

/**
 * Matrix-structure check (§ Phase 4): for each plan section carrying computed `matrix` data, enforce
 * the FIXED table DOM — every planned item id appears in exactly one `data-matrix-cell` of the right
 * column, each `data-matrix-row` carries exactly `columns.length` cell slots, a filled cell has
 * exactly one `data-bind="price"` span, and a null (em-dash) cell has none. Catches the observed
 * failure where the painter rendered stacked name+price cards instead of a real comparison table.
 */
export function checkMatrixStructure(root: HTMLElement, plan: PlanScreen): QaFinding[] {
  const findings: QaFinding[] = [];
  for (const section of plan.sections) {
    const matrix = section.matrix;
    if (matrix === undefined) continue;
    const cols = matrix.columns.length;

    // Expected column per filled item id (from the computed matrix).
    const expectedColumn = new Map<string, string>();
    for (const row of matrix.rows) {
      row.cells.forEach((cell, ci) => {
        if (cell !== null) expectedColumn.set(cell, matrix.columns[ci] ?? "");
      });
    }
    const filledIds = new Set(expectedColumn.keys());
    const container = findMatrixContainer(root, filledIds);
    const domRows = container.querySelectorAll("[data-matrix-row]");
    const domCells = container.querySelectorAll("[data-matrix-cell]");

    // The painter ignored the matrix skeleton entirely → one finding, not one-per-item noise.
    if (domRows.length === 0 && domCells.length === 0) {
      findings.push(
        makeFinding({
          kind: FindingKind.MatrixStructure,
          source: "deterministic",
          severity: "major",
          tag: "layout",
          region: section.title,
          message: `Section "${section.title}" carries matrix data but no data-matrix table was rendered (render a true row×column comparison table).`,
        }),
      );
      continue;
    }

    // 1. Each row carries exactly `cols` cell slots.
    for (const rowEl of domRows) {
      const cellCount = rowEl.querySelectorAll("[data-matrix-cell]").length;
      if (cellCount !== cols) {
        findings.push(
          makeFinding({
            kind: FindingKind.MatrixStructure,
            source: "deterministic",
            severity: "major",
            tag: "layout",
            region: section.title,
            message: `Matrix row "${rowEl.getAttribute("data-matrix-row") ?? ""}" has ${cellCount} cell(s); expected ${cols} (one per column).`,
            data: { expected: cols, actual: cellCount },
          }),
        );
      }
    }

    // 2/3. Walk cells: filled cells → exactly one price span + correct column; null cells → none.
    const seen = new Map<string, number>();
    for (const cell of domCells) {
      const id = cell.getAttribute("data-item-id");
      const priceCount = cell.querySelectorAll('[data-bind="price"]').length;
      if (id !== undefined && id !== "") {
        seen.set(id, (seen.get(id) ?? 0) + 1);
        if (priceCount !== 1) {
          findings.push(
            makeFinding({
              kind: FindingKind.MatrixStructure,
              source: "deterministic",
              severity: "major",
              tag: "content",
              region: section.title,
              itemId: id,
              message: `Matrix cell for "${id}" has ${priceCount} data-bind="price" span(s); a filled cell needs exactly one.`,
              data: { priceCount },
            }),
          );
        }
        const expected = expectedColumn.get(id);
        const column = cell.getAttribute("data-matrix-cell") ?? "";
        if (expected !== undefined && column !== expected) {
          findings.push(
            makeFinding({
              kind: FindingKind.MatrixStructure,
              source: "deterministic",
              severity: "major",
              tag: "content",
              region: section.title,
              itemId: id,
              message: `Matrix cell for "${id}" is in column "${column}"; expected "${expected}".`,
              data: { column, expected },
            }),
          );
        }
      } else if (priceCount > 0) {
        findings.push(
          makeFinding({
            kind: FindingKind.MatrixStructure,
            source: "deterministic",
            severity: "major",
            tag: "content",
            region: section.title,
            message: `An empty matrix cell in "${section.title}" has ${priceCount} price span(s); an em-dash cell must have none.`,
            data: { priceCount },
          }),
        );
      }
    }

    // 4. Every planned item appears in exactly one cell.
    for (const id of filledIds) {
      const count = seen.get(id) ?? 0;
      if (count !== 1) {
        findings.push(
          makeFinding({
            kind: FindingKind.MatrixStructure,
            source: "deterministic",
            severity: "major",
            tag: "content",
            region: section.title,
            itemId: id,
            message: `Matrix item "${id}" appears in ${count} matrix cell(s); expected exactly one.`,
            data: { count },
          }),
        );
      }
    }
  }
  return findings;
}

/**
 * HTML-attribute-escape a section title the way it appears in shipped markup — the SAME escaping the
 * eval grader's `escapeAttr` uses, so this engine check and `gradeCategoryImages` agree on membership.
 */
function escapeSlotTitle(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Image-slot presence (D29-review Fix 4): every plan section carrying an `imageSlot` must render an
 * element with data-image-slot="<section title>", and a board-level screen `imageSlot` requires a
 * data-image-slot="shared" element. Prompt-only guarantees aren't guarantees — a run-5 board shipped
 * with BOTH its per-section slots missing yet PASSED QA; only the eval grader caught it. Keyed off
 * the PLAN's slots (exactly what the painter was directed to render) and matched with the SAME regex
 * + escaping `gradeCategoryImages` uses, so engine and harness agree. A major/content finding, not
 * deterministically fixable → routes to re-paint via the default `actionable-to-repaint` rule.
 */
export function checkImageSlots(ctx: StructuralContext): QaFinding[] {
  const plan = ctx.planScreen;
  const wantsSection = plan.sections.some((s) => s.imageSlot !== undefined);
  const wantsShared = plan.imageSlot !== undefined;
  if (!wantsSection && !wantsShared) return [];
  const slotValues = new Set(
    [...ctx.html.matchAll(/data-image-slot\s*=\s*"([^"]*)"/g)].map((m) => m[1] ?? ""),
  );
  const findings: QaFinding[] = [];
  for (const section of plan.sections) {
    if (section.imageSlot === undefined) continue;
    if (!slotValues.has(escapeSlotTitle(section.title))) {
      findings.push(
        makeFinding({
          kind: "image-slot-missing",
          source: "deterministic",
          severity: "major",
          tag: "content",
          region: section.title,
          message: `Section "${section.title}" carries a planned image slot but no element with data-image-slot="${section.title}" was rendered.`,
        }),
      );
    }
  }
  if (wantsShared && !slotValues.has("shared")) {
    findings.push(
      makeFinding({
        kind: "image-slot-missing",
        source: "deterministic",
        severity: "major",
        tag: "content",
        message:
          'The board plan carries a shared image slot but no element with data-image-slot="shared" was rendered.',
      }),
    );
  }
  return findings;
}

/** When a brand logo was requested, guarantee the painter actually rendered the header placeholder
 * and that it was inlined (no leaked remote/relative src). Mirrors binding-integrity for items. */
export function checkBrandBinding(root: HTMLElement, ctx: StructuralContext): QaFinding[] {
  if (ctx.brandLogoRequested !== true) return [];
  const logos = root.querySelectorAll("[data-brand-logo]");
  if (logos.length === 0) {
    return [
      makeFinding({
        kind: FindingKind.BrandBinding,
        source: "deterministic",
        severity: "major",
        tag: "structural",
        message:
          "Brand logo was provided but no <img data-brand-logo> header element was rendered.",
      }),
    ];
  }
  const findings: QaFinding[] = [];
  for (const el of logos) {
    const src = (el.getAttribute("src") ?? "").trim();
    if (src !== "" && !DATA_URI.test(src)) {
      findings.push(
        makeFinding({
          kind: FindingKind.BrandBinding,
          source: "deterministic",
          severity: "major",
          tag: "structural",
          message: `Brand logo carries a non-inlined src="${src}"; it must be a data-URI.`,
          data: { value: src },
        }),
      );
    }
  }
  return findings;
}

/** Run every structural check: token-lint on the raw markup, the rest on the packaged artifact. */
export function runStructuralChecks(ctx: StructuralContext): QaFinding[] {
  const pkgRoot = parse(ctx.html);
  const rawRoot = ctx.rawHtml !== undefined ? parse(ctx.rawHtml) : pkgRoot;
  return [
    ...checkCapacity(ctx.planScreen, ctx.qa),
    ...checkBindings(pkgRoot, ctx),
    ...checkPricePresent(pkgRoot, ctx),
    ...checkRepresentations(pkgRoot, ctx.planScreen, ctx.items),
    ...checkMatrixStructure(pkgRoot, ctx.planScreen),
    ...checkImageSlots(ctx),
    ...checkTokenLint(rawRoot, ctx),
    ...checkMotion(pkgRoot, ctx),
    ...checkSelfContained(pkgRoot, ctx),
    ...checkBrandBinding(pkgRoot, ctx),
  ];
}
