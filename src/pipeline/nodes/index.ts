import type { CritiqueFinding } from "../../domain/contracts";
import { PackagingError, PaintError, RenderError, ThemeNotFoundError } from "../../domain/errors";
import { parseOrThrow } from "../../domain/parse";
import { thinPlanSchema } from "../../domain/schemas";
import type { QaFinding } from "../../domain/types";
import { orientViewport } from "../../config/qa";
import { applyDeterministicRepairs, contrastIsFixable } from "../../repairs/index";
import { describeLayoutStrategy, renderMatrixSummary } from "../../planning/layout-strategy";
import { FindingKind, makeFinding } from "../../qa/finding";
import { decideGate } from "../../qa/gate";
import { describeDesignIntent } from "../../theme/design-intent";
import { runRenderedChecks, checkViewport } from "../../qa/rendered-checks";
import { isComposedHtml, runStructuralChecks } from "../../qa/structural-checks";
import { scoreScreen } from "../../qa/scoring";
import { resolveTheme } from "../../theme/resolve";
import { isInlineImageRef } from "../../util/placeholder-image";
import { route } from "../router";
import type { CritiqueRequest } from "../../ports/vision-critic";
import type { NodeContext, EngineState } from "../state";
import { renderBlueprintStrategy } from "../../planning/layout-strategy";
import {
  blueprintFor,
  boardCorrelation,
  currentScreen,
  densityTierFor,
  effectiveScreen,
  plannedSectionItemIds,
  resolveScreenItems,
  runCorrelation,
  sizeDirectiveFor,
  typeScaleFor,
} from "./shared";

/** plan: load the hand-authored plan from input, else ask the Planner port (spec §5.4). */
export async function planNode(
  ctx: NodeContext,
  state: EngineState,
): Promise<Partial<EngineState>> {
  // Prefer a plan already on state (the engine resolves it once and seeds it per screen),
  // else the caller's input plan, else the Planner port.
  const raw =
    state.plan ??
    state.input.plan ??
    (await ctx.ports.planner.plan(state.input, runCorrelation(state)));
  const plan = parseOrThrow(thinPlanSchema, raw, "thin plan");
  return { plan };
}

/** resolveTheme: fetch the preset and apply brief perturbations (spec §5.3). */
export async function resolveThemeNode(
  ctx: NodeContext,
  state: EngineState,
): Promise<Partial<EngineState>> {
  const presetId = state.input.brief.presetId;
  const preset = await ctx.ports.themeRepository.get(presetId);
  if (!preset) {
    throw new ThemeNotFoundError(`No theme preset registered for id "${presetId}".`, {
      details: { presetId },
    });
  }
  return { theme: resolveTheme(preset, state.input.brief) };
}

/**
 * fetchImages: resolve this screen's item photos to offline-safe data-URIs BEFORE paint, so
 * paint/QA/package/render only ever see `data:` URIs (spec §5.1, S9). Scoped to the current
 * screen's items (the graph runs once per board) — never the whole menu. Runs once before the
 * QA loop; data-URIs pass through untouched, so re-paint iterations pay no extra network.
 *
 * PHOTO TRUTH: a remote ref that fails to resolve is DROPPED from the item's images — never
 * substituted with the 1×1 placeholder. A placeholder in `item.images` lies to the whole
 * pipeline (the painter's photo allowlist, the plan's imageSlot, the crop check) and ships a
 * stretched transparent pixel as a "hero" the paint loop can never fix. The placeholder remains
 * only the PACKAGE-time fallback for dangling data-img refs (the packager guard, untouched).
 */
export async function fetchImagesNode(
  ctx: NodeContext,
  state: EngineState,
): Promise<Partial<EngineState>> {
  if (!state.plan) return {};
  const screen = currentScreen(state.plan, state.screenIndex);
  const boardTag = `board ${state.screenIndex + 1}/${state.plan.screens.length} "${screen.id}"`;
  const items = resolveScreenItems(screen, state.input.items);

  const remote = new Set<string>();
  for (const item of items)
    for (const ref of item.images ?? []) if (!isInlineImageRef(ref)) remote.add(ref);

  const resolvedByUrl =
    remote.size > 0 ? await ctx.ports.imageFetcher.fetch([...remote]) : new Map<string, string>();
  if (remote.size > 0) {
    ctx.ports.logger?.info(`${boardTag}: inlined ${resolvedByUrl.size}/${remote.size} photo(s)`);
  }

  const resolvedItems = items.map((item) => {
    if (!item.images || item.images.length === 0) return item;
    const images = item.images
      .map((ref) => (isInlineImageRef(ref) ? ref : resolvedByUrl.get(ref)))
      .filter((ref): ref is string => ref !== undefined);
    if (images.length === item.images.length) return { ...item, images };
    ctx.ports.logger?.warn(
      `${boardTag}: images: "${item.name}" (${item.id}) photo failed to fetch — excluded from paint`,
    );
    // Drop the images key entirely when none survive (exactOptionalPropertyTypes — never pass
    // `{ images: undefined }`) so `withPhotos`/imageSlot filters see a genuinely photo-less item.
    const { images: _dropped, ...rest } = item;
    return images.length > 0 ? { ...rest, images } : rest;
  });
  return { resolvedItems };
}

/** paint: free-paint the screen on rails; minimal-change on a re-paint (spec §5.2, §10.6). */
export async function paintNode(
  ctx: NodeContext,
  state: EngineState,
): Promise<Partial<EngineState>> {
  if (!state.plan || !state.theme)
    throw new PaintError("paint requires a resolved plan and theme.");
  const planned = currentScreen(state.plan, state.screenIndex);
  const items = state.resolvedItems ?? resolveScreenItems(planned, state.input.items);
  // Photo truth: paint against the EFFECTIVE screen — the imageSlot filtered to items that still
  // carry a photo after fetch — so the painter never builds a carousel slide for a missing asset.
  const screen = effectiveScreen(planned, items);
  ctx.ports.logger?.info(
    `board ${state.screenIndex + 1}/${state.plan.screens.length} "${screen.id}": painting (attempt ${state.iteration + 1})`,
  );

  const viewport = orientViewport(ctx.config.qa.viewport, state.input.constraints.aspect);
  const blueprint = blueprintFor(screen, items, state.theme, ctx.config.layouts);
  // Board-family context: a board painted with knowledge it belongs to a multi-screen set so the
  // painter keeps one shared visual system across siblings. Only when the set has >1 board (a lone
  // board has no siblings) — spread conditionally (exactOptionalPropertyTypes).
  const total = state.plan.screens.length;
  const html = await ctx.ports.painter.paint({
    planScreen: screen,
    items,
    theme: state.theme,
    constraints: state.input.constraints,
    viewport: { width: viewport.width, height: viewport.height },
    antiPatterns: ctx.config.painter.antiPatterns,
    blueprint,
    sizeDirective: sizeDirectiveFor(screen, viewport, ctx.config.planning),
    densityTier: densityTierFor(screen, viewport, ctx.config.planning),
    correlation: boardCorrelation(state, screen.id),
    ...(total > 1 ? { board: { index: state.screenIndex + 1, total } } : {}),
    ...(state.html !== undefined ? { previousHtml: state.html } : {}),
    ...(state.findings.length > 0 ? { findings: state.findings } : {}),
    ...(state.input.brand !== undefined ? { brand: state.input.brand } : {}),
  });
  if (!html || html.trim() === "") throw new PaintError("painter returned empty HTML.");
  // A fresh paint clears the no-progress flag: a subsequent repair operates on new markup and can
  // be effective again (D65).
  return { html, iteration: state.iteration + 1, repairIneffective: false };
}

/** package: compile + inline into the self-contained artifact QA renders (spec §5.2, D4). */
export async function packageNode(
  ctx: NodeContext,
  state: EngineState,
): Promise<Partial<EngineState>> {
  if (!state.html || !state.theme || !state.plan)
    throw new PackagingError("package requires painted HTML, a plan, and a theme.");
  const screen = currentScreen(state.plan, state.screenIndex);
  const items = state.resolvedItems ?? resolveScreenItems(screen, state.input.items);
  const packagedHtml = await ctx.ports.packager.package({
    html: state.html,
    theme: state.theme,
    items,
    ...(state.input.brand?.logo?.src !== undefined
      ? { brandLogoDataUri: state.input.brand.logo.src }
      : {}),
  });
  if (!packagedHtml || packagedHtml.trim() === "")
    throw new PackagingError("packager returned empty HTML.");
  ctx.ports.logger?.debug(
    `board ${state.screenIndex + 1} "${screen.id}": packaged ${Math.round(state.html.length / 1024)}KB raw → ${Math.round(packagedHtml.length / 1024)}KB (Tailwind compiled, photos inlined)`,
  );
  return { packagedHtml };
}

/** deterministicQA: render at exact viewport, run pure structural + rendered checks (spec §5.6a). */
export async function deterministicQaNode(
  ctx: NodeContext,
  state: EngineState,
): Promise<Partial<EngineState>> {
  if (!state.packagedHtml || !state.plan || !state.theme) {
    throw new RenderError("deterministicQA requires a packaged screen, plan, and theme.");
  }
  const screen = currentScreen(state.plan, state.screenIndex);
  const theme = state.theme;
  const items = state.resolvedItems ?? resolveScreenItems(screen, state.input.items);
  const viewport = orientViewport(ctx.config.qa.viewport, state.input.constraints.aspect);
  const { width, height } = viewport;
  ctx.ports.logger?.info(
    `board ${state.screenIndex + 1}/${state.plan.screens.length} "${screen.id}": rendering ${width}×${height} + QA checks`,
  );

  const { observation, screenshotBase64 } = await ctx.ports.browser.render({
    html: state.packagedHtml,
    viewport,
  });

  // Hard precondition: the render must match the target viewport/DPR (§5.6a) — fail loudly.
  const viewportFinding = checkViewport(observation, viewport);
  if (viewportFinding) {
    throw new RenderError(
      viewportFinding.message,
      viewportFinding.data ? { details: viewportFinding.data } : {},
    );
  }

  // Density + legibility are graded against the SAME sizing/tier output the painter was directed
  // with (D26/D30): a board the PLAN forced over the comfortable budget is expected to be dense —
  // warn on over-fill, don't major; a `packed` board's items get the relaxed compact-register floor.
  const typeScale = typeScaleFor(screen, viewport, ctx.config.planning);
  const tier = densityTierFor(screen, viewport, ctx.config.planning);
  // Grade structural checks against the EFFECTIVE screen the painter/critic actually rendered — the
  // imageSlot filtered (or dropped) for photos that failed to fetch (photo truth, shared with paint
  // + vision). Coverage/sections/matrix are untouched by this, so only the image-slot presence check
  // depends on it: without it, a board whose shared slot was dropped for missing photos would
  // false-fire image-slot-missing against a slot the painter was correctly told NOT to render.
  const paintedScreen = effectiveScreen(screen, items);
  const findings: QaFinding[] = [
    ...runStructuralChecks({
      html: state.packagedHtml,
      ...(state.html !== undefined ? { rawHtml: state.html } : {}),
      planScreen: paintedScreen,
      items,
      theme: state.theme,
      qa: ctx.config.qa,
      tokenLint: ctx.config.tokenLint,
      brandLogoRequested: state.input.brand?.logo !== undefined,
    }),
    ...runRenderedChecks(observation, ctx.config.qa, screen, {
      overBudget: typeScale.overBudget,
      tier,
    }),
  ].map((f) =>
    // Re-mark contrast: a token swap only helps on a scopable selector over a solid bg. Contrast
    // over a photo (or a bare-tag selector) is NOT deterministically fixable → it routes to
    // re-paint (the painter adds a scrim) instead of looping on a futile/destructive repair.
    f.kind === FindingKind.Contrast
      ? { ...f, deterministicallyFixable: contrastIsFixable(f, theme) }
      : f,
  );
  ctx.ports.logger?.debug(
    `board ${state.screenIndex + 1} "${screen.id}": ${findings.length} deterministic finding(s)`,
    { findings: findings.map((f) => f.kind) },
  );
  // Reset the per-iteration vision flag alongside the fresh findings: visionQA sets it true only if
  // it actually runs, so a shipped candidate whose vision pass was skipped is legible to freeze.
  return { findings, screenshotBase64, visionCritiqued: false };
}

function toVisionFinding(f: CritiqueFinding): QaFinding {
  return makeFinding({
    kind: f.dimension,
    source: "vision",
    severity: f.severity,
    tag: f.tag,
    region: f.region,
    message: f.message,
  });
}

/**
 * Build the vision-critic request for a candidate screenshot. Shared by `visionQA` (per iteration)
 * and the `freeze` make-good critique so the request is constructed ONE way — no duplicated
 * request-building. It grades against the SAME effective screen, blueprint strategy, matrix summary,
 * size directive, density tier, item count, canvas and correlation the painter was directed with
 * ("two consumers, same text"), and honours photo truth (the imageSlot filtered to items whose
 * photos resolved). `screenshotBase64` is the candidate under judgement — the current render for
 * `visionQA`, `best.screenshotBase64` at freeze.
 */
function buildCritiqueRequest(
  ctx: NodeContext,
  state: EngineState,
  screenshotBase64: string,
): CritiqueRequest {
  if (!state.plan) throw new RenderError("vision critique requires a resolved plan.");
  const planned = currentScreen(state.plan, state.screenIndex);
  const items = state.resolvedItems ?? resolveScreenItems(planned, state.input.items);
  const screen = effectiveScreen(planned, items);
  const aspect = state.input.constraints.aspect;
  const viewport = orientViewport(ctx.config.qa.viewport, aspect);
  // Grade against the SAME blueprint the painter was told to fill (falls back to the legacy strategy
  // when the theme isn't resolved, which shouldn't happen post-resolveTheme). Append the SAME matrix
  // summary the painter saw so the critic judges the table against the exact pairing it rendered.
  const baseStrategy =
    state.theme !== undefined
      ? renderBlueprintStrategy(blueprintFor(screen, items, state.theme, ctx.config.layouts))
      : describeLayoutStrategy(screen);
  const matrixSummary = renderMatrixSummary(screen, items);
  // A composed board was sized by the fitter's register search, not the free-painter's rem-target
  // directive — briefing the critic with that directive grades it against sizes it never received
  // (false "type too small" findings). Omit the size directive for composed candidates; densityTier
  // below is kept (it describes content, not painter instructions). D73.
  const composed = state.html !== undefined && isComposedHtml(state.html);
  const sizeDirective = composed
    ? undefined
    : sizeDirectiveFor(screen, viewport, ctx.config.planning);
  // A composed board's masthead title is intentionally model-authored (the sole sanctioned invented-copy
  // field — D74): tell the critic so it never majors the title as invented copy. Item-level names/prices
  // stay strictly data-bound. Composed candidates ONLY — the free-paint brief is byte-identical (this
  // note is undefined there and filtered out, leaving the join unchanged).
  const composedTitleNote = composed
    ? "TITLE NOTE (D74): the board's masthead title is intentionally model-authored (a sanctioned, " +
      "composed headline) — do NOT flag it as invented copy. Item names and prices remain strictly " +
      "data-bound; flag those if invented."
    : undefined;
  const layoutStrategy = [baseStrategy, matrixSummary, sizeDirective, composedTitleNote]
    .filter((s): s is string => s !== undefined)
    .join("\n\n");
  return {
    screenshotBase64,
    planScreen: screen,
    rubric: ctx.config.rubric,
    ...(state.theme !== undefined
      ? { designIntent: describeDesignIntent(state.theme, ctx.config.painter.antiPatterns) }
      : {}),
    layoutStrategy,
    // Judge a dense/packed board AS a dense board (D30): the compact register is required, not a flaw.
    densityTier: densityTierFor(screen, viewport, ctx.config.planning),
    itemCount: plannedSectionItemIds(screen).length,
    canvas: { width: viewport.width, height: viewport.height, aspect },
    correlation: boardCorrelation(state, screen.id),
  };
}

/**
 * visionQA: the cheap-VLM rubric pass (spec §5.6). Skipped when deterministic QA already
 * GATE-BLOCKS this candidate — it can never pass this iteration and the blocking finding already
 * selects the route, so the paid critique cannot change the outcome (D27, the cheap-vs-frontier
 * cost split, §5.6/§9). With `qa.skipVisionWhenBlocking` off, only a hard gate skips (legacy
 * behaviour). Vision findings are appended to the deterministic set; `visionCritiqued` records that
 * this candidate WAS critiqued (so a skip is legible to freeze — Fix 1).
 */
export async function visionQaNode(
  ctx: NodeContext,
  state: EngineState,
): Promise<Partial<EngineState>> {
  if (!state.plan || !state.screenshotBase64) return {};
  const skip = ctx.config.qa.skipVisionWhenBlocking
    ? decideGate(state.findings, ctx.config.qa.blockingSeverity).blocking
    : state.findings.some((f) => f.hardGate);
  if (skip) return {};

  const planned = currentScreen(state.plan, state.screenIndex);
  ctx.ports.logger?.info(
    `board ${state.screenIndex + 1}/${state.plan.screens.length} "${planned.id}": vision critique`,
  );
  const critique = await ctx.ports.visionCritic.critique(
    buildCritiqueRequest(ctx, state, state.screenshotBase64),
  );
  const vision = critique.findings.map(toVisionFinding);
  return { findings: [...state.findings, ...vision], visionCritiqued: true };
}

/**
 * score: compute this candidate's score, maintain best-so-far via the comparator (D12), and
 * record the routing decision (router is the sole termination authority).
 */
export async function scoreNode(
  ctx: NodeContext,
  state: EngineState,
): Promise<Partial<EngineState>> {
  if (
    state.html === undefined ||
    state.packagedHtml === undefined ||
    state.screenshotBase64 === undefined
  ) {
    throw new RenderError("score requires a rendered candidate.");
  }
  const score = scoreScreen(state.findings, ctx.config.rubric, ctx.config.qa.blockingSeverity);
  const candidate = {
    html: state.html,
    packagedHtml: state.packagedHtml,
    screenshotBase64: state.screenshotBase64,
    findings: state.findings,
    score: score.total,
    // Persist the human-meaningful rubric fraction + penalty alongside the comparator total, so the
    // frozen report carries a 0..1 score a person can read, not just the internal ordering (D28).
    rubricScore: score.rubricScore,
    penalty: score.penalty,
    passed: score.passed,
    iterations: state.iteration,
    // Snapshot whether THIS iteration was vision-critiqued, so freeze can tell an un-critiqued
    // shipped candidate (paid pass skipped on a gate-blocked iteration, D27) from a clean-critiqued
    // one and run a single make-good critique only on the former (Fix 1).
    critiqued: state.visionCritiqued,
  };

  // Maintain best-so-far: a worse later iteration never replaces the best (D12).
  const best = !state.best || candidate.score > state.best.score ? candidate : state.best;

  const decision = route(
    {
      findings: state.findings,
      iteration: state.iteration,
      passed: score.passed,
      repairIneffective: state.repairIneffective,
    },
    ctx.config.routing,
    ctx.config.loop,
  );
  ctx.ports.logger?.info(
    `board ${state.screenIndex + 1}: score ${score.total.toFixed(3)} → ${decision}${score.passed ? " ✓" : ""}`,
  );

  if (ctx.ports.debug) {
    await ctx.ports.debug.capture({
      screenIndex: state.screenIndex,
      screenId: state.plan
        ? currentScreen(state.plan, state.screenIndex).id
        : `${state.screenIndex}`,
      iteration: state.iteration,
      route: decision,
      score: score.total,
      passed: score.passed,
      rawHtml: state.html,
      packagedHtml: state.packagedHtml,
      screenshotBase64: state.screenshotBase64,
      findings: state.findings,
    });
  }

  return { best, route: decision, routeHistory: [...state.routeHistory, decision] };
}

/**
 * repair: a pure deterministic mechanical fix (D13); the LlmRepairer port is the fallback. Sets
 * `repairIneffective` when the pass produced HTML byte-identical to its input — a no-progress repair
 * the router must not re-choose (it would loop forever); the router then escalates to a re-paint
 * (D65). A repair that genuinely changed the markup clears the flag.
 */
export async function repairNode(
  ctx: NodeContext,
  state: EngineState,
): Promise<Partial<EngineState>> {
  if (state.html === undefined || state.theme === undefined) {
    throw new PaintError("repair requires painted HTML and a theme.");
  }
  const before = state.html;
  const deterministic = applyDeterministicRepairs(before, state.findings, state.theme);
  if (deterministic.applied && deterministic.html !== before) {
    ctx.ports.logger?.debug("deterministic repair applied", { note: deterministic.note });
    return { html: deterministic.html, iteration: state.iteration + 1, repairIneffective: false };
  }
  if (ctx.ports.llmRepairer) {
    const correlation = state.plan
      ? boardCorrelation(state, currentScreen(state.plan, state.screenIndex).id)
      : runCorrelation(state);
    const repaired = await ctx.ports.llmRepairer.repair({
      html: before,
      theme: state.theme,
      findings: state.findings,
      correlation,
    });
    return {
      html: repaired.html,
      iteration: state.iteration + 1,
      repairIneffective: repaired.html === before,
    };
  }
  // Nothing applicable — advance the budget and flag the no-op so the router escalates to a re-paint
  // rather than re-selecting this same do-nothing repair (D65).
  ctx.ports.logger?.warn("repair node reached with no applicable repair");
  return { iteration: state.iteration + 1, repairIneffective: true };
}

/** freeze: lock the best-scoring artifact and emit screen + poster + report (spec §5.6, D4). */
export async function freezeNode(
  ctx: NodeContext,
  state: EngineState,
): Promise<Partial<EngineState>> {
  if (!state.plan || !state.theme || !state.best) {
    throw new RenderError("freeze requires a plan, theme, and a scored best candidate.");
  }
  const screen = currentScreen(state.plan, state.screenIndex);
  const viewport = orientViewport(ctx.config.qa.viewport, state.input.constraints.aspect);
  let best = state.best;

  // Freeze-path make-good critique (Fix 1): the shipped candidate is `best`, which may have been
  // chosen on an iteration whose paid vision pass was SKIPPED because deterministic QA gate-blocked
  // it (D27) — so it would ship with ZERO vision findings and a vacuous rubricScore of 1.00. The
  // per-iteration skip is correct (a blocked candidate can't pass that iteration), but the SHIPPED
  // board must carry one honest critique. Critique `best` ONCE, merge the findings, and rescore for
  // the REPORT only: this never re-selects `best` (the loop is over) and MUST NOT flip `passed` — a
  // blocked board stays flagged and new vision findings never change routing. On any critic failure
  // we ship exactly today's report (best untouched). The `passed: best.passed` pin below is now
  // LOAD-BEARING (D69): a make-good critique can surface a vision `critical`, which the gate would
  // block on if rescored freely — but this path only runs for an already-gate-blocked (never-passed)
  // candidate, and the pin guarantees a merged critical can never retroactively flip a shipped pass.
  if (!best.critiqued) {
    try {
      ctx.ports.logger?.info(
        `board ${state.screenIndex + 1} "${screen.id}": freeze-path vision critique (shipped candidate was never critiqued)`,
      );
      const critique = await ctx.ports.visionCritic.critique(
        buildCritiqueRequest(ctx, state, best.screenshotBase64),
      );
      const findings = [...best.findings, ...critique.findings.map(toVisionFinding)];
      const rescored = scoreScreen(findings, ctx.config.rubric, ctx.config.qa.blockingSeverity);
      best = {
        ...best,
        findings,
        score: rescored.total,
        rubricScore: rescored.rubricScore,
        penalty: rescored.penalty,
        // Pin `passed` to the loop's decision — the freeze critique reports, it never re-routes.
        passed: best.passed,
        critiqued: true,
      };
    } catch (error) {
      ctx.ports.logger?.warn(
        `board ${state.screenIndex + 1} "${screen.id}": freeze-path critique failed — shipping without it: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  ctx.ports.logger?.info(
    `board ${state.screenIndex + 1} "${screen.id}": frozen — passed=${best.passed}, iterations=${best.iterations}`,
  );

  return {
    frozen: {
      screen: {
        id: screen.id,
        html: best.packagedHtml,
        itemIds: plannedSectionItemIds(screen),
        meta: {
          presetId: state.input.brief.presetId,
          aspect: state.input.constraints.aspect,
          width: viewport.width,
          height: viewport.height,
        },
      },
      poster: {
        screenId: screen.id,
        pngBase64: best.screenshotBase64,
        width: viewport.width,
        height: viewport.height,
      },
      report: {
        screenId: screen.id,
        passed: best.passed,
        flagged: !best.passed,
        iterations: best.iterations,
        score: best.score,
        rubricScore: best.rubricScore,
        penalty: best.penalty,
        findings: best.findings,
        routeHistory: state.routeHistory,
      },
    },
  };
}
