import type { FindingSource, FindingTag, QaFinding, Severity } from "../domain/types";

/** Well-known finding kinds emitted by the engine's own checks. `kind` stays a free string
 * (rules-as-data), so these are conveniences, not an exhaustive enum. */
export const FindingKind = {
  Contrast: "contrast",
  Overflow: "overflow",
  OverflowCapacity: "overflow-capacity",
  Density: "density",
  Viewport: "viewport",
  ImageSlot: "image-slot",
  BindingMissing: "binding-missing",
  BindingDuplicate: "binding-duplicate",
  BindingMismatch: "binding-mismatch",
  BindingHookMissing: "binding-hook-missing",
  TokenLint: "token-lint",
  MotionVocab: "motion-vocab",
  SelfContained: "self-contained",
  BakedPlayer: "baked-player",
  Representation: "representation",
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
