import type { QaConfig } from "../config/qa";
import type { QaFinding } from "../domain/types";
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
export function checkViewport(obs: RenderObservation, qa: QaConfig): QaFinding | null {
  const { width, height, dpr } = qa.viewport;
  const a = obs.actualViewport;
  if (a.width === width && a.height === height && a.dpr === dpr) return null;
  return makeFinding({
    kind: FindingKind.Viewport,
    source: "deterministic",
    severity: "critical",
    tag: "structural",
    hardGate: true,
    message: `Rendered viewport ${a.width}x${a.height}@${a.dpr} does not match target ${width}x${height}@${dpr}.`,
    data: { actual: a, expected: qa.viewport },
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

/** Density bounds — too empty (dead space) or too crammed → re-paint (§5.6). */
export function checkDensity(obs: RenderObservation, qa: QaConfig): QaFinding[] {
  const { minFill, maxFill } = qa.density;
  if (obs.fillRatio < minFill) {
    return [
      makeFinding({
        kind: FindingKind.Density,
        source: "deterministic",
        severity: "major",
        tag: "layout",
        message: `Screen is under-filled (${(obs.fillRatio * 100).toFixed(0)}% < ${(
          minFill * 100
        ).toFixed(0)}%) — dead space.`,
        data: { fillRatio: obs.fillRatio, minFill, kind: "under" },
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
export function runRenderedChecks(obs: RenderObservation, qa: QaConfig): QaFinding[] {
  return [
    ...checkContrast(obs, qa),
    ...checkOverflow(obs, qa),
    ...checkDensity(obs, qa),
    ...checkImages(obs),
  ];
}
