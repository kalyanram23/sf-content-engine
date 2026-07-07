import type { FindingSource, FindingTag, QaFinding, Severity } from "../domain/types";

/** Well-known finding kinds emitted by the engine's own checks. `kind` stays a free string
 * (rules-as-data), so these are conveniences, not an exhaustive enum. */
export const FindingKind = {
  Contrast: "contrast",
  Legibility: "legibility",
  Overflow: "overflow",
  OverflowCapacity: "overflow-capacity",
  ItemCutoff: "item-cutoff",
  Density: "density",
  DeadBand: "dead-band",
  Viewport: "viewport",
  ImageSlot: "image-slot",
  ImageDistortion: "image-distortion",
  ImageCrop: "image-crop",
  MatrixStructure: "matrix-structure",
  BindingMissing: "binding-missing",
  BindingDuplicate: "binding-duplicate",
  BindingMismatch: "binding-mismatch",
  BindingHookMissing: "binding-hook-missing",
  TokenLint: "token-lint",
  MotionVocab: "motion-vocab",
  SelfContained: "self-contained",
  BakedPlayer: "baked-player",
  Representation: "representation",
  BrandBinding: "brand-binding",
} as const;

export interface FindingInput {
  kind: string;
  source: FindingSource;
  severity: Severity;
  tag: FindingTag;
  message: string;
  region?: string;
  itemId?: string;
  data?: Record<string, unknown>;
  hardGate?: boolean;
  deterministicallyFixable?: boolean;
}

/** Build a {@link QaFinding}, defaulting `hardGate`/`deterministicallyFixable` to false. */
export function makeFinding(input: FindingInput): QaFinding {
  return { hardGate: false, deterministicallyFixable: false, ...input };
}

/**
 * Per-kind whitelist of `finding.data` keys surfaced to the painter/repairer. The checks compute
 * machine-precise anchors (overshoot px, fill ratio, image aspect, contrast ratio + the exact
 * overflowing element refs) that the prompt builders used to strip — leaving the model to guess at
 * a 26px overshoot it could never localize. This exposes ONLY these scalar/ref keys; bboxes, raw
 * sample arrays and any un-listed key are never serialized. `overflowing` is handled specially
 * (capped ref list), so it is not listed here.
 */
const SPECIFIC_KEYS: Record<string, readonly string[]> = {
  [FindingKind.Overflow]: ["overshootX", "overshootY"],
  [FindingKind.ItemCutoff]: ["worstOverhangPx", "count"],
  [FindingKind.Density]: ["fillRatio", "minFill", "maxFill"],
  [FindingKind.ImageSlot]: ["ref", "renderedAspect", "naturalAspect"],
  [FindingKind.ImageDistortion]: ["ref", "renderedAspect", "naturalAspect"],
  [FindingKind.ImageCrop]: ["ref", "renderedAspect", "naturalAspect"],
  [FindingKind.Contrast]: ["ratio", "required", "fontPx"],
};

/** Max refs from a finding's `overflowing` list to spell out before truncating with "+N more". */
const MAX_OVERFLOW_REFS = 5;
/** Hard cap per serialized line so one pathological finding can't blow the prompt budget. */
const MAX_LINE_CHARS = 480;

/** Format a single `data` value defensively (values are `unknown`): numbers get a compact fixed
 * form, strings pass through, anything else is dropped. */
function formatDataValue(value: unknown): string | undefined {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return undefined;
    return Number.isInteger(value) ? String(value) : value.toFixed(2);
  }
  if (typeof value === "string" && value !== "") return value;
  return undefined;
}

/** The " | key=…; …" specifics tail for one finding, from its per-kind whitelist. Empty for an
 * unknown kind or a finding with no matching `data` keys. */
function findingSpecifics(finding: QaFinding): string {
  const data = finding.data;
  if (data === undefined) return "";
  const parts: string[] = [];
  const keys = SPECIFIC_KEYS[finding.kind];
  if (keys !== undefined) {
    for (const key of keys) {
      const formatted = formatDataValue(data[key]);
      if (formatted !== undefined) parts.push(`${key}=${formatted}`);
    }
  }
  // Overflow carries the exact overflowing element refs — the most actionable anchor of all — but
  // the list can be long, so cap it and note the remainder rather than dumping the raw array.
  if (finding.kind === FindingKind.Overflow) {
    const refs = data["overflowing"];
    if (Array.isArray(refs)) {
      const stringRefs = refs.filter((r): r is string => typeof r === "string" && r !== "");
      const shown = stringRefs.slice(0, MAX_OVERFLOW_REFS);
      if (shown.length > 0) {
        const rest = stringRefs.length - shown.length;
        const suffix = rest > 0 ? ` +${rest} more` : "";
        parts.push(`overflowing=${shown.join(", ")}${suffix}`);
      }
    }
  }
  return parts.length > 0 ? ` | ${parts.join("; ")}` : "";
}

/**
 * Render QA findings as compact, element-anchored prompt lines — one per finding — for the painter
 * re-paint block and the LLM repairer. Format:
 *   `- [<severity>] <kind> @ <region> (item <itemId>): <message> | <specifics>`
 * where `<specifics>` is the per-kind {@link SPECIFIC_KEYS} whitelist (absent for unknown kinds).
 * Vision findings flow through here too, so it must never assume a `kind`/`data` shape and never
 * crash on missing fields. Each line is hard-capped at {@link MAX_LINE_CHARS}.
 */
export function serializeFindingsForPrompt(findings: readonly QaFinding[]): string {
  return findings
    .map((f) => {
      const item = f.itemId !== undefined ? ` (item ${f.itemId})` : "";
      const region = f.region ?? "screen";
      const line = `- [${f.severity}] ${f.kind} @ ${region}${item}: ${f.message}${findingSpecifics(f)}`;
      return line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS - 1)}…` : line;
    })
    .join("\n");
}
