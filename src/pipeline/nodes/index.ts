import type { CritiqueFinding } from "../../domain/contracts";
import { PackagingError, PaintError, RenderError, ThemeNotFoundError } from "../../domain/errors";
import { parseOrThrow } from "../../domain/parse";
import { thinPlanSchema } from "../../domain/schemas";
import type { QaFinding } from "../../domain/types";
import { applyDeterministicRepairs } from "../../repairs/index";
import { makeFinding } from "../../qa/finding";
import { runRenderedChecks, checkViewport } from "../../qa/rendered-checks";
import { runStructuralChecks } from "../../qa/structural-checks";
import { scoreScreen } from "../../qa/scoring";
import { resolveTheme } from "../../theme/resolve";
import { route } from "../router";
import type { NodeContext, EngineState } from "../state";
import { currentScreen, plannedSectionItemIds, resolveScreenItems } from "./shared";

/** plan: load the hand-authored plan from input, else ask the Planner port (spec §5.4). */
export async function planNode(
  ctx: NodeContext,
  state: EngineState,
): Promise<Partial<EngineState>> {
  // Prefer a plan already on state (the engine resolves it once and seeds it per screen),
  // else the caller's input plan, else the Planner port.
  const raw = state.plan ?? state.input.plan ?? (await ctx.ports.planner.plan(state.input));
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

/** paint: free-paint the screen on rails; minimal-change on a re-paint (spec §5.2, §10.6). */
export async function paintNode(
  ctx: NodeContext,
  state: EngineState,
): Promise<Partial<EngineState>> {
  if (!state.plan || !state.theme)
    throw new PaintError("paint requires a resolved plan and theme.");
  const screen = currentScreen(state.plan, state.screenIndex);
  const items = resolveScreenItems(screen, state.input.items);
  ctx.ports.logger?.info(
    `board ${state.screenIndex + 1}/${state.plan.screens.length} "${screen.id}": painting (attempt ${state.iteration + 1})`,
  );

  const html = await ctx.ports.painter.paint({
    planScreen: screen,
    items,
    theme: state.theme,
    constraints: state.input.constraints,
    ...(state.html !== undefined ? { previousHtml: state.html } : {}),
    ...(state.findings.length > 0 ? { findings: state.findings } : {}),
  });
  if (!html || html.trim() === "") throw new PaintError("painter returned empty HTML.");
  return { html, iteration: state.iteration + 1 };
}

/** package: compile + inline into the self-contained artifact QA renders (spec §5.2, D4). */
export async function packageNode(
  ctx: NodeContext,
  state: EngineState,
): Promise<Partial<EngineState>> {
  if (!state.html || !state.theme)
    throw new PackagingError("package requires painted HTML and a theme.");
  const packagedHtml = await ctx.ports.packager.package({ html: state.html, theme: state.theme });
  if (!packagedHtml || packagedHtml.trim() === "")
    throw new PackagingError("packager returned empty HTML.");
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
  const items = resolveScreenItems(screen, state.input.items);
  const { width, height } = ctx.config.qa.viewport;
  ctx.ports.logger?.info(
    `board ${state.screenIndex + 1}/${state.plan.screens.length} "${screen.id}": rendering ${width}×${height} + QA checks`,
  );

  const { observation, screenshotBase64 } = await ctx.ports.browser.render({
    html: state.packagedHtml,
    viewport: ctx.config.qa.viewport,
  });

  // Hard precondition: the render must match the target viewport/DPR (§5.6a) — fail loudly.
  const viewportFinding = checkViewport(observation, ctx.config.qa);
  if (viewportFinding) {
    throw new RenderError(
      viewportFinding.message,
      viewportFinding.data ? { details: viewportFinding.data } : {},
    );
  }

  const findings: QaFinding[] = [
    ...runStructuralChecks({
      html: state.packagedHtml,
      ...(state.html !== undefined ? { rawHtml: state.html } : {}),
      planScreen: screen,
      items,
      theme: state.theme,
      qa: ctx.config.qa,
      tokenLint: ctx.config.tokenLint,
    }),
    ...runRenderedChecks(observation, ctx.config.qa),
  ];
  ctx.ports.logger?.debug(
    `board ${state.screenIndex + 1} "${screen.id}": ${findings.length} deterministic finding(s)`,
    { findings: findings.map((f) => f.kind) },
  );
  return { findings, screenshotBase64 };
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
 * visionQA: the cheap-VLM rubric pass (spec §5.6). Skipped when a deterministic hard gate
 * already failed — no point critiquing aesthetics of a screen that fails contrast (the
 * cheap-vs-frontier cost split, §5.6/§9). Vision findings are appended to the deterministic set.
 */
export async function visionQaNode(
  ctx: NodeContext,
  state: EngineState,
): Promise<Partial<EngineState>> {
  if (!state.plan || !state.screenshotBase64) return {};
  if (state.findings.some((f) => f.hardGate)) return {};

  const screen = currentScreen(state.plan, state.screenIndex);
  ctx.ports.logger?.info(
    `board ${state.screenIndex + 1}/${state.plan.screens.length} "${screen.id}": vision critique`,
  );
  const critique = await ctx.ports.visionCritic.critique({
    screenshotBase64: state.screenshotBase64,
    planScreen: screen,
    rubric: ctx.config.rubric,
  });
  const vision = critique.findings.map(toVisionFinding);
  return { findings: [...state.findings, ...vision] };
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
    passed: score.passed,
    iterations: state.iteration,
  };

  // Maintain best-so-far: a worse later iteration never replaces the best (D12).
  const best = !state.best || candidate.score > state.best.score ? candidate : state.best;

  const decision = route(
    { findings: state.findings, iteration: state.iteration },
    ctx.config.routing,
    ctx.config.loop,
  );
  ctx.ports.logger?.info(
    `board ${state.screenIndex + 1}: score ${score.total.toFixed(3)} → ${decision}${score.passed ? " ✓" : ""}`,
  );

  return { best, route: decision, routeHistory: [...state.routeHistory, decision] };
}

/** repair: a pure deterministic mechanical fix (D13); the LlmRepairer port is the fallback. */
export async function repairNode(
  ctx: NodeContext,
  state: EngineState,
): Promise<Partial<EngineState>> {
  if (state.html === undefined || state.theme === undefined) {
    throw new PaintError("repair requires painted HTML and a theme.");
  }
  const deterministic = applyDeterministicRepairs(state.html, state.findings, state.theme);
  if (deterministic.applied) {
    ctx.ports.logger?.debug("deterministic repair applied", { note: deterministic.note });
    return { html: deterministic.html, iteration: state.iteration + 1 };
  }
  if (ctx.ports.llmRepairer) {
    const repaired = await ctx.ports.llmRepairer.repair({
      html: state.html,
      theme: state.theme,
      findings: state.findings,
    });
    return { html: repaired.html, iteration: state.iteration + 1 };
  }
  // Nothing applicable — advance the budget so the loop terminates (router will then freeze).
  ctx.ports.logger?.warn("repair node reached with no applicable repair");
  return { iteration: state.iteration + 1 };
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
  const { viewport } = ctx.config.qa;
  const best = state.best;
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
        findings: best.findings,
        routeHistory: state.routeHistory,
      },
    },
  };
}
