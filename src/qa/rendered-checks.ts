import type { QaConfig, ViewportConfig } from "../config/qa";
import type { DensityTier, PlanScreen, QaFinding } from "../domain/types";
import type { RenderObservation } from "../ports/browser";
import { contrastRatio, requiredRatio } from "./contrast";
import { FindingKind, makeFinding } from "./finding";

/**
 * Pure checks over a {@link RenderObservation} (D3). The browser does the rendering and
 * pixel sampling; everything here is deterministic math over its output.
 */

/**
 * Hard precondition (§5.6a): the artifact MUST have been rendered at the exact target
 * viewport + DPR, or every downstream rendered check is meaningless. Returns a finding on
 * mismatch (the node turns it into a loud `RenderError`).
 */
export function checkViewport(obs: RenderObservation, viewport: ViewportConfig): QaFinding | null {
  const { width, height, dpr } = viewport;
  const a = obs.actualViewport;
  if (a.width === width && a.height === height && a.dpr === dpr) return null;
  return makeFinding({
    kind: FindingKind.Viewport,
    source: "deterministic",
    severity: "critical",
    tag: "structural",
    hardGate: true,
    message: `Rendered viewport ${a.width}x${a.height}@${a.dpr} does not match target ${width}x${height}@${dpr}.`,
    data: { actual: a, expected: viewport },
  });
}

/** WCAG contrast — a hard gate (§10.4); failures are deterministically fixable via token swap. */
export function checkContrast(obs: RenderObservation, qa: QaConfig): QaFinding[] {
  const findings: QaFinding[] = [];
  for (const sample of obs.textSamples) {
    const ratio = contrastRatio(sample.fg, sample.bg);
    const required = requiredRatio(sample.fontPx, sample.bold, qa.contrast);
    if (ratio + 1e-6 < required) {
      findings.push(
        makeFinding({
          kind: FindingKind.Contrast,
          source: "deterministic",
          severity: "critical",
          tag: "mechanical",
          hardGate: true,
          deterministicallyFixable: true,
          region: sample.ref,
          ...(sample.itemId !== undefined ? { itemId: sample.itemId } : {}),
          message: `Contrast ${ratio.toFixed(2)}:1 below required ${required}:1 at "${sample.ref}".`,
          data: {
            ratio,
            required,
            fg: sample.fg,
            bg: sample.bg,
            fontPx: sample.fontPx,
            bold: sample.bold,
          },
        }),
      );
    }
  }
  return findings;
}

/**
 * Legibility floor (read across a room): item-bound text below the configured px floor is a
 * layout failure → re-paint. Only samples INSIDE an item node are held to the floor (small
 * chrome/footnotes are legitimate); items in a `matrix` section get the relaxed table floor, and a
 * `packed` board (D30) — a maximally-dense price wall the plan forced — is treated the same, since a
 * compact table-like register there is deliberate, not a shrink-to-fit escape. `comfortable`/`dense`
 * boards keep the full floor. Offenders are aggregated into ONE finding so a shrunken 30-row board
 * doesn't flood the loop.
 */
export function checkLegibility(
  obs: RenderObservation,
  qa: QaConfig,
  planScreen?: PlanScreen,
  sizing?: BoardSizing,
): QaFinding[] {
  const matrixItemIds = new Set<string>(
    (planScreen?.sections ?? [])
      .filter((s) => s.representation === "matrix")
      .flatMap((s) => s.items),
  );
  const packed = sizing?.tier === "packed";
  const offenders = obs.textSamples
    .filter((s) => s.itemId !== undefined)
    .map((s) => ({
      sample: s,
      floor:
        packed || matrixItemIds.has(s.itemId ?? "")
          ? qa.legibility.matrixItemMinPx
          : qa.legibility.itemMinPx,
    }))
    .filter(({ sample, floor }) => sample.fontPx < floor);
  if (offenders.length === 0) return [];

  const worst = offenders.reduce((a, b) => (a.sample.fontPx <= b.sample.fontPx ? a : b));
  return [
    makeFinding({
      kind: FindingKind.Legibility,
      source: "deterministic",
      severity: "major",
      tag: "layout",
      region: worst.sample.ref,
      ...(worst.sample.itemId !== undefined ? { itemId: worst.sample.itemId } : {}),
      message:
        `${offenders.length} item text element(s) below the legibility floor ` +
        `(worst: "${worst.sample.ref}" at ${worst.sample.fontPx.toFixed(1)}px < ${worst.floor}px). ` +
        `Enlarge the text — reclaim empty space instead of shrinking type.`,
      data: {
        count: offenders.length,
        offenders: offenders
          .slice(0, 8)
          .map(({ sample, floor }) => ({ ref: sample.ref, fontPx: sample.fontPx, floor })),
      },
    }),
  ];
}

/**
 * The uniform shrink factor that would bring overflowing content back inside the viewport, plus
 * whether applying it is SAFE. A single scale on both axes (aspect-preserving → photos never
 * distort) sized to the tighter overflowing axis. The factor is floored to 3 dp so the re-render
 * clears the tolerance rather than landing exactly on the edge, and is `< 1` whenever overflow is
 * present. `fixable` is true only when that scale stays at/above BOTH the config `minShrinkFactor`
 * floor and every item-bound text sample's legibility floor (matrix/packed items get the relaxed
 * matrix floor, matching {@link checkLegibility}, D30) — a shrink that trades an overflow finding
 * for an illegible-type finding is a net loss (D31).
 */
function overflowShrinkPlan(
  obs: RenderObservation,
  qa: QaConfig,
  planScreen?: PlanScreen,
  sizing?: BoardSizing,
): { shrinkFactor: number; fixable: boolean } {
  const { scrollWidth, scrollHeight, clientWidth, clientHeight } = obs.scroll;
  const fitX = scrollWidth > 0 ? clientWidth / scrollWidth : 1;
  const fitY = scrollHeight > 0 ? clientHeight / scrollHeight : 1;
  const shrinkFactor = Math.max(0, Math.floor(Math.min(fitX, fitY, 1) * 1000) / 1000);

  const packed = sizing?.tier === "packed";
  const matrixItemIds = new Set<string>(
    (planScreen?.sections ?? [])
      .filter((s) => s.representation === "matrix")
      .flatMap((s) => s.items),
  );
  let minLegibleFactor = 0;
  for (const s of obs.textSamples) {
    if (s.itemId === undefined || s.fontPx <= 0) continue;
    const floor =
      packed || matrixItemIds.has(s.itemId)
        ? qa.legibility.matrixItemMinPx
        : qa.legibility.itemMinPx;
    minLegibleFactor = Math.max(minLegibleFactor, floor / s.fontPx);
  }

  const floor = Math.max(qa.overflowRepair.minShrinkFactor, minLegibleFactor);
  const fixable = shrinkFactor > 0 && shrinkFactor < 1 && shrinkFactor >= floor;
  return { shrinkFactor, fixable };
}

/**
 * Content overflowing the fixed-size screen. Two outcomes, mirroring the contrast split (D13/§5.6):
 * a shrink-to-fit that stays legible is **deterministically fixable** — a pure repair scales the
 * content root by `shrinkFactor` so it fits, WITHOUT burning a paint iteration on an LLM that
 * reliably re-overflows (D31); otherwise it routes to re-paint (the pre-existing behaviour). The
 * `deterministicallyFixable` flag + `shrinkFactor` are computed here (the check has the observation,
 * the plan and the sizing) so the repair stays a pure function of the finding — the router's existing
 * `mechanical-fix-to-repair` rule then prefers repair over re-paint automatically.
 */
export function checkOverflow(
  obs: RenderObservation,
  qa: QaConfig,
  planScreen?: PlanScreen,
  sizing?: BoardSizing,
): QaFinding[] {
  const tol = qa.overflowTolerancePx;
  const overshootY = obs.scroll.scrollHeight - obs.scroll.clientHeight;
  const overshootX = obs.scroll.scrollWidth - obs.scroll.clientWidth;
  if (overshootY <= tol && overshootX <= tol) return [];
  const { shrinkFactor, fixable } = overflowShrinkPlan(obs, qa, planScreen, sizing);
  return [
    makeFinding({
      kind: FindingKind.Overflow,
      source: "deterministic",
      severity: "major",
      tag: "layout",
      deterministicallyFixable: fixable,
      message:
        `Content overflows the screen (overshoot ${Math.max(overshootX, 0)}x${Math.max(overshootY, 0)}px)` +
        `${fixable ? ` — shrink-to-fit ×${shrinkFactor}` : ""}.`,
      data: {
        overshootX,
        overshootY,
        shrinkFactor,
        overflowing: obs.overflowing.map((o) => o.ref),
      },
    }),
  ];
}

/** True when a board reads as type-led — carrying a computed matrix, or dominated by type-led
 * representations (matrix/list) — so its under-fill floor is relaxed (§ Phase 5). */
function isTypeLedBoard(planScreen: PlanScreen, typeLed: readonly string[]): boolean {
  const sections = planScreen.sections;
  if (sections.some((s) => s.matrix !== undefined)) return true;
  return sections.length > 0 && sections.every((s) => typeLed.includes(s.representation));
}

/**
 * The board's plan-time sizing verdict, derived from the SAME `computeTypeScale` output the
 * painter directive comes from (D26). Deliberately a minimal local shape (not the sizing module's
 * `TypeScaleDirective`) so the QA layer stays free of a planning-module dependency.
 */
export interface BoardSizing {
  /** True when the plan forced more rows than the canvas's comfortable budget (over-budget regime). */
  overBudget: boolean;
  /** The board's density tier (D30) — a `packed` board's item text gets the relaxed legibility floor. */
  tier?: DensityTier;
}

/**
 * Density bounds — too empty (dead space) or too crammed → re-paint (§5.6). Plan-aware: a sparse
 * board (few planned items) is held to the relaxed `sparseMinFill` floor, and a TYPE-LED board
 * (matrix/list — a price table legitimately breathes) to the even lower `typeLedMinFill` floor
 * (§ Phase 5), so neither is punished by a floor calibrated for full photo menus. The OVER-fill
 * bound is universal in trigger but graded against the plan's own sizing (D26): a board the plan
 * forced over the comfortable budget gets `planForcedOverFillSeverity` (warn), not a major.
 */
export function checkDensity(
  obs: RenderObservation,
  qa: QaConfig,
  planScreen?: PlanScreen,
  sizing?: BoardSizing,
): QaFinding[] {
  const { maxFill, sparseItemCount, sparseMinFill, typeLedMinFill, underFillSeverity } = qa.density;
  const itemCount = planScreen?.sections.reduce((n, s) => n + s.items.length, 0);
  const sparse = itemCount !== undefined && itemCount <= sparseItemCount;
  const typeLed =
    planScreen !== undefined && isTypeLedBoard(planScreen, qa.density.typeLedRepresentations);
  // Take the lowest applicable floor: a sparse type-led matrix board gets the most slack.
  let minFill = qa.density.minFill;
  if (sparse) minFill = Math.min(minFill, sparseMinFill);
  if (typeLed) minFill = Math.min(minFill, typeLedMinFill);
  if (obs.fillRatio < minFill) {
    return [
      makeFinding({
        kind: FindingKind.Density,
        source: "deterministic",
        severity: underFillSeverity,
        tag: "layout",
        message: `Screen is under-filled (${(obs.fillRatio * 100).toFixed(0)}% < ${(
          minFill * 100
        ).toFixed(
          0,
        )}%${typeLed ? ", type-led floor" : sparse ? ", sparse-board floor" : ""}) — dead space.`,
        data: {
          fillRatio: obs.fillRatio,
          minFill,
          kind: "under",
          ...(sparse ? { sparse } : {}),
          ...(typeLed ? { typeLed } : {}),
        },
      }),
    ];
  }
  if (obs.fillRatio > maxFill) {
    // A PLAN-FORCED dense board (over-budget rows, D26) is expected to sit above maxFill: the
    // painter was explicitly directed to compose dense, so this is a note, not a paint failure.
    const planForced = sizing?.overBudget === true;
    return [
      makeFinding({
        kind: FindingKind.Density,
        source: "deterministic",
        severity: planForced ? qa.density.planForcedOverFillSeverity : "major",
        tag: "layout",
        message: planForced
          ? `Screen is dense (${(obs.fillRatio * 100).toFixed(0)}% > ${(maxFill * 100).toFixed(
              0,
            )}%) — plan-forced (rows exceed the comfortable budget); acceptable while nothing overflows.`
          : `Screen is over-crammed (${(obs.fillRatio * 100).toFixed(0)}% > ${(
              maxFill * 100
            ).toFixed(0)}%).`,
        data: {
          fillRatio: obs.fillRatio,
          maxFill,
          kind: "over",
          ...(planForced ? { planForced } : {}),
        },
      }),
    ];
  }
  return [];
}

/** Image-slot integrity — galleries must actually have loaded (§5.6). */
export function checkImages(obs: RenderObservation): QaFinding[] {
  return obs.images
    .filter((img) => !img.loaded || img.naturalWidth === 0)
    .map((img) =>
      makeFinding({
        kind: FindingKind.ImageSlot,
        source: "deterministic",
        severity: "major",
        tag: "content",
        region: img.ref,
        message: `Image "${img.ref}" failed to load.`,
        data: { ref: img.ref, naturalWidth: img.naturalWidth },
      }),
    );
}

/**
 * Image geometry (§ Phase 4) — the "did it load?" check missed two ways a food photo ships wrong:
 * `fill`/`none` squishing it off its natural aspect (distortion), and a `cover` image in an extreme
 * band slicing it (over-crop). Pure over the observation's per-image geometry; images missing the
 * geometry fields (older observations / fakes) are skipped so the check never false-positives.
 */
export function checkImageGeometry(obs: RenderObservation, qa: QaConfig): QaFinding[] {
  const { distortionTolerance, maxCropFactor } = qa.image;
  const findings: QaFinding[] = [];
  for (const img of obs.images) {
    const nw = img.naturalWidth;
    const nh = img.naturalHeight;
    const rw = img.renderedWidth;
    const rh = img.renderedHeight;
    // Need full geometry to reason about aspect; skip when any dimension is missing/zero.
    if (nh === undefined || rw === undefined || rh === undefined) continue;
    if (nw <= 0 || nh <= 0 || rw <= 0 || rh <= 0) continue;
    // A 1×1 natural image is a placeholder pixel (the package-time fallback), not a photo — its
    // "aspect" is meaningless, so comparing it to the container is a guaranteed false positive.
    if (nw === 1 && nh === 1) continue;
    const naturalAspect = nw / nh;
    const renderedAspect = rw / rh;

    if (img.objectFit === "fill" || img.objectFit === "none") {
      const deviation = Math.abs(renderedAspect - naturalAspect) / naturalAspect;
      if (deviation > distortionTolerance) {
        findings.push(
          makeFinding({
            kind: FindingKind.ImageDistortion,
            source: "deterministic",
            severity: "major",
            tag: "layout",
            region: img.ref,
            message: `Image "${img.ref}" is distorted (object-fit:${img.objectFit}, aspect ${renderedAspect.toFixed(2)} vs natural ${naturalAspect.toFixed(2)}). Use object-cover in a well-proportioned box.`,
            data: {
              ref: img.ref,
              objectFit: img.objectFit,
              renderedAspect,
              naturalAspect,
              deviation,
            },
          }),
        );
      }
    } else if (img.objectFit === "cover") {
      const factor = Math.max(renderedAspect / naturalAspect, naturalAspect / renderedAspect);
      if (factor > maxCropFactor) {
        findings.push(
          makeFinding({
            kind: FindingKind.ImageCrop,
            source: "deterministic",
            severity: "major",
            tag: "layout",
            region: img.ref,
            message: `Image "${img.ref}" is over-cropped (container aspect ${renderedAspect.toFixed(2)} vs natural ${naturalAspect.toFixed(2)}, factor ${factor.toFixed(2)} > ${maxCropFactor}). Give the photo a box closer to its own proportions — no thin slice bands.`,
            data: { ref: img.ref, renderedAspect, naturalAspect, factor, maxCropFactor },
          }),
        );
      }
    }
  }
  return findings;
}

/** All rendered checks except the viewport precondition (handled separately by the node). */
export function runRenderedChecks(
  obs: RenderObservation,
  qa: QaConfig,
  planScreen?: PlanScreen,
  sizing?: BoardSizing,
): QaFinding[] {
  return [
    ...checkContrast(obs, qa),
    ...checkLegibility(obs, qa, planScreen, sizing),
    ...checkOverflow(obs, qa, planScreen, sizing),
    ...checkDensity(obs, qa, planScreen, sizing),
    ...checkImages(obs),
    ...checkImageGeometry(obs, qa),
  ];
}
