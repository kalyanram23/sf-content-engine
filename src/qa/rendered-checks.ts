import type { QaConfig, ViewportConfig } from "../config/qa";
import type { PlanScreen, QaFinding } from "../domain/types";
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
 * chrome/footnotes are legitimate); items in a `matrix` section get the relaxed table floor.
 * Offenders are aggregated into ONE finding so a shrunken 30-row board doesn't flood the loop.
 */
export function checkLegibility(
  obs: RenderObservation,
  qa: QaConfig,
  planScreen?: PlanScreen,
): QaFinding[] {
  const matrixItemIds = new Set<string>(
    (planScreen?.sections ?? [])
      .filter((s) => s.representation === "matrix")
      .flatMap((s) => s.items),
  );
  const offenders = obs.textSamples
    .filter((s) => s.itemId !== undefined)
    .map((s) => ({
      sample: s,
      floor: matrixItemIds.has(s.itemId ?? "")
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

/** Content overflowing the fixed-size screen → re-paint (layout problem). */
export function checkOverflow(obs: RenderObservation, qa: QaConfig): QaFinding[] {
  const tol = qa.overflowTolerancePx;
  const overshootY = obs.scroll.scrollHeight - obs.scroll.clientHeight;
  const overshootX = obs.scroll.scrollWidth - obs.scroll.clientWidth;
  if (overshootY <= tol && overshootX <= tol) return [];
  return [
    makeFinding({
      kind: FindingKind.Overflow,
      source: "deterministic",
      severity: "major",
      tag: "layout",
      message: `Content overflows the screen (overshoot ${Math.max(overshootX, 0)}x${Math.max(overshootY, 0)}px).`,
      data: { overshootX, overshootY, overflowing: obs.overflowing.map((o) => o.ref) },
    }),
  ];
}

/**
 * Density bounds — too empty (dead space) or too crammed → re-paint (§5.6). Plan-aware: a
 * sparse board (few planned items) is held to the relaxed `sparseMinFill` floor, so an
 * intentionally airy hero board isn't punished by a floor calibrated for full menus.
 */
export function checkDensity(
  obs: RenderObservation,
  qa: QaConfig,
  planScreen?: PlanScreen,
): QaFinding[] {
  const { maxFill, sparseItemCount, sparseMinFill, underFillSeverity } = qa.density;
  const itemCount = planScreen?.sections.reduce((n, s) => n + s.items.length, 0);
  const sparse = itemCount !== undefined && itemCount <= sparseItemCount;
  const minFill = sparse ? sparseMinFill : qa.density.minFill;
  if (obs.fillRatio < minFill) {
    return [
      makeFinding({
        kind: FindingKind.Density,
        source: "deterministic",
        severity: underFillSeverity,
        tag: "layout",
        message: `Screen is under-filled (${(obs.fillRatio * 100).toFixed(0)}% < ${(
          minFill * 100
        ).toFixed(0)}%${sparse ? ", sparse-board floor" : ""}) — dead space.`,
        data: { fillRatio: obs.fillRatio, minFill, kind: "under", ...(sparse ? { sparse } : {}) },
      }),
    ];
  }
  if (obs.fillRatio > maxFill) {
    return [
      makeFinding({
        kind: FindingKind.Density,
        source: "deterministic",
        severity: "major",
        tag: "layout",
        message: `Screen is over-crammed (${(obs.fillRatio * 100).toFixed(0)}% > ${(
          maxFill * 100
        ).toFixed(0)}%).`,
        data: { fillRatio: obs.fillRatio, maxFill, kind: "over" },
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

/** All rendered checks except the viewport precondition (handled separately by the node). */
export function runRenderedChecks(
  obs: RenderObservation,
  qa: QaConfig,
  planScreen?: PlanScreen,
): QaFinding[] {
  return [
    ...checkContrast(obs, qa),
    ...checkLegibility(obs, qa, planScreen),
    ...checkOverflow(obs, qa),
    ...checkDensity(obs, qa, planScreen),
    ...checkImages(obs),
  ];
}
