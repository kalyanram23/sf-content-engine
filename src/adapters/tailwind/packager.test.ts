import { describe, expect, it } from "vitest";

import type { CanonicalItem, ThemePreset } from "../../domain/types";
import { parseOrThrow } from "../../domain/parse";
import { themePresetSchema } from "../../domain/schemas";
import { resolveTheme } from "../../theme/resolve";
import { botanicalPreset } from "../../theme/presets/botanical";
import { ICON_GLYPHS } from "../../theme/icon-glyphs";
import { checkSelfContained } from "../../qa/structural-checks";
import { PACKAGED_BASE_LINE_HEIGHT } from "../../composition/renderer";
import { PLACEHOLDER_IMAGE_DATA_URI } from "../../util/placeholder-image";
import { parse } from "node-html-parser";
import { TailwindPackager } from "./packager";
import bazaarThemeJson from "../../../themes/bazaar.theme.json";
import blockframeThemeJson from "../../../themes/blockframe.theme.json";
import boldPosterThemeJson from "../../../themes/bold-poster.theme.json";
import bubblegumThemeJson from "../../../themes/bubblegum.theme.json";
import dhabaThemeJson from "../../../themes/dhaba.theme.json";

const theme = resolveTheme(botanicalPreset, { presetId: "botanical" });

/**
 * Only `botanical` ships a bundled TS preset (src/theme/presets/botanical.ts); the other five
 * bundled themes (D71/D78/D79) live ONLY as `themes/<id>.theme.json`, loaded at runtime by the
 * Node `FileThemeRepository`. Load + validate them here the same way, so this pin exercises the
 * exact theme data a real deployment compiles from.
 */
const BUNDLED_THEME_PRESETS: Record<string, ThemePreset> = {
  botanical: botanicalPreset,
  dhaba: parseOrThrow(themePresetSchema, dhabaThemeJson, "dhaba theme file"),
  bubblegum: parseOrThrow(themePresetSchema, bubblegumThemeJson, "bubblegum theme file"),
  bazaar: parseOrThrow(themePresetSchema, bazaarThemeJson, "bazaar theme file"),
  blockframe: parseOrThrow(themePresetSchema, blockframeThemeJson, "blockframe theme file"),
  "bold-poster": parseOrThrow(themePresetSchema, boldPosterThemeJson, "bold-poster theme file"),
};

/** Packages a minimal board through the real compiler for one bundled theme id. */
function packageFixture(presetId: string): Promise<string> {
  const preset = BUNDLED_THEME_PRESETS[presetId];
  if (!preset) throw new Error(`no bundled theme preset registered for "${presetId}"`);
  const resolved = resolveTheme(preset, { presetId });
  const html = `<main class="flex gap-4 p-6 rounded-md"><h2 class="text-text">Hi</h2><span class="text-price">$1.00</span></main>`;
  return new TailwindPackager().package({ html, theme: resolved, items: [] });
}

describe("TailwindPackager (real compile, hermetic)", () => {
  it("compiles utilities, injects token vars, and emits a self-contained document", async () => {
    const html = `<main class="flex gap-4 p-6 rounded-md"><h2 class="text-text">Hi</h2><span class="text-price">$1.00</span></main>`;
    const packaged = await new TailwindPackager().package({ html, theme, items: [] });

    expect(packaged).toContain("<!doctype html>");
    expect(packaged).toContain("<style>");
    // A compiled utility from the candidate set is present.
    expect(packaged).toMatch(/\.flex\s*\{[^}]*display\s*:\s*flex/);
    // Theme colour tokens are exposed as CSS variables (used by the contrast repair).
    expect(packaged).toContain("--color-bg");
    // The Motion runtime marker is inlined (offline-safe, D14).
    expect(packaged).toContain("data-motion-runtime");

    // No external references survived (self-contained / offline-safe, §5.1).
    const findings = checkSelfContained(parse(packaged));
    expect(findings).toEqual([]);
  }, 60_000);

  it("defines EVERY theme color token as a CSS var, even ones used only via inline var() or unused (D67)", async () => {
    // Regression (dhaba truck-art frame): token-lint blesses `var(--color-<token>)`, so the painter
    // legitimately references a colour ONLY inside an inline gradient (never via a utility class).
    // Tailwind v4 `@theme` tree-shakes variables no utility references, so such a token — and any
    // token used nowhere on a given board — never reached the packaged CSS: the gradient pointed at
    // an undefined var, the browser dropped the whole background, and the frame rendered invisible.
    // Invariant: any token the lint blesses must be defined in the packaged CSS unconditionally.
    const html =
      // `accent` appears ONLY inside an inline gradient (no utility class references it), mirroring
      // the dhaba signature frame; the other tokens (sold, surface-strong, …) are used nowhere.
      `<div style="background:repeating-linear-gradient(45deg,var(--color-accent) 0,var(--color-accent) 8px,transparent 8px,transparent 16px)">` +
      `<h2 class="text-text">Hi</h2></div>`; // one ordinary utility, to prove utilities still resolve
    const packaged = await new TailwindPackager().package({ html, theme, items: [] });

    // The utility-referenced token still resolves to a real declaration.
    expect(packaged).toMatch(/\.text-text\s*\{[^}]*color/);
    // And EVERY colour token in the resolved theme is defined as a CSS variable.
    for (const name of Object.keys(theme.tokens.colors)) {
      expect(packaged, `--color-${name} must be defined in the packaged CSS`).toContain(
        `--color-${name}:`,
      );
    }
  }, 60_000);

  it("inlines item photos as data-URIs and injects the motion runtime for a runtime preset", async () => {
    const item: CanonicalItem = {
      id: "i1",
      name: "Veg Noodles",
      available: true,
      images: ["data:image/png;base64,AAAA"],
    };
    const html =
      `<div data-motion="gallery-fade" data-motion-params="interval:5000;fade:800">` +
      `<img data-img-item="i1" data-img-index="0" data-ref="indo-carousel-0" ` +
      `class="absolute inset-0 w-full h-full object-cover opacity-100">` +
      `<img data-img-item="i1" data-img-index="0" data-ref="indo-carousel-1" ` +
      `class="absolute inset-0 w-full h-full object-cover opacity-0"></div>`;
    const packaged = await new TailwindPackager().package({ html, theme, items: [item] });

    // The placeholder <img> got its data-URI src from the resolved item.
    expect(packaged).toContain('src="data:image/png;base64,AAAA"');
    // The bundled vanilla motion.dev core is inlined (offline) behind the runtime marker.
    expect(packaged).toContain("data-motion-runtime");
    expect(packaged).toContain("__ceMotion");
    // Still fully self-contained: the inlined runtime trips no external-ref / baked-player rule.
    expect(checkSelfContained(parse(packaged))).toEqual([]);
  }, 60_000);

  it("falls back to an offline placeholder when an item has no matching photo", async () => {
    const html = `<img data-img-item="missing" data-img-index="0" data-ref="x-0">`;
    const packaged = await new TailwindPackager().package({ html, theme, items: [] });
    expect(packaged).toContain(`src="${PLACEHOLDER_IMAGE_DATA_URI}"`);
    expect(checkSelfContained(parse(packaged))).toEqual([]);
  }, 60_000);

  it("inlines the brand logo data-URI into the [data-brand-logo] placeholder", async () => {
    const logo = "data:image/png;base64,AAAABBBB";
    const html = '<main><header><img data-brand-logo alt="Acme"></header></main>';
    const packaged = await new TailwindPackager().package({
      html,
      theme,
      items: [],
      brandLogoDataUri: logo,
    });
    expect(packaged).toContain(`src="${logo}"`);
    expect(packaged).toContain("data-brand-logo");
  }, 60_000);

  it("emits @font-face with the declared font-weight (so two same-family faces don't collide)", async () => {
    // A theme embedding one family at two weights: each face must carry its own font-weight, or
    // both collapse to `normal` and the bold face never renders (B5 / bold-poster relies on this).
    const weighted = {
      ...theme,
      assets: {
        ...theme.assets,
        fonts: [
          { family: "Archivo", dataUri: "data:font/woff2;base64,AAAA", weight: "500" },
          { family: "Archivo", dataUri: "data:font/woff2;base64,BBBB", weight: "700" },
          { family: "Shrikhand", dataUri: "data:font/woff2;base64,CCCC" },
        ],
      },
    };
    const packaged = await new TailwindPackager().package({
      html: '<main class="text-text">Hi</main>',
      theme: weighted,
      items: [],
    });
    expect(packaged).toContain("font-family:'Archivo';font-weight:500;");
    expect(packaged).toContain("font-family:'Archivo';font-weight:700;");
    // A face with no declared weight defaults to normal.
    expect(packaged).toContain("font-family:'Shrikhand';font-weight:normal;");
  }, 60_000);

  it("inlines the named curated glyph into an <svg data-icon> marker (preserving its classes)", async () => {
    // The painter emits an EMPTY marker picking a glyph name; the packager injects the real glyph so
    // icon quality is engine-owned (LLM-drawn food art ships broken). The marker's own class (the
    // theme text-token colour) is preserved; a viewBox + currentColor stroke is added.
    const html =
      '<div><svg data-icon="curry-pot" class="w-24 h-24 text-accent-strong"></svg></div>';
    const packaged = await new TailwindPackager().package({ html, theme, items: [] });
    expect(packaged).toContain("text-accent-strong"); // marker class kept
    expect(packaged).toContain(`viewBox="${ICON_GLYPHS["curry-pot"]!.viewBox}"`);
    expect(packaged).toContain('stroke="currentColor"');
    // The curated inner paths landed inside the marker (curry-pot's distinctive pot-body path).
    expect(packaged).toContain("M5 10");
    expect(packaged).toContain("<path");
    // No external ref survived — the inlined glyph is self-contained.
    expect(checkSelfContained(parse(packaged))).toEqual([]);
  }, 60_000);

  it("falls back to the generic platter glyph for an unknown data-icon name", async () => {
    const html = '<svg data-icon="not-a-real-glyph" class="text-text"></svg>';
    const packaged = await new TailwindPackager().package({ html, theme, items: [] });
    // The platter-generic glyph's distinctive base line + viewBox were injected.
    expect(packaged).toContain("M2 16");
    expect(packaged).toContain(`viewBox="${ICON_GLYPHS["platter-generic"]!.viewBox}"`);
    expect(checkSelfContained(parse(packaged))).toEqual([]);
  }, 60_000);

  it("packaged Preflight base line-height equals the offline MEASURE constant (D77 clip-guard pin)", async () => {
    // D77 landscape-clip fix: the off-screen MEASURE document (src/composition/renderer.ts,
    // buildMeasureDoc) sets the measured root's line-height to PACKAGED_BASE_LINE_HEIGHT so measured
    // price-row heights equal the SHIPPED render — a packaged row declares a font-size but no
    // line-height and inherits Tailwind Preflight's unitless base `line-height:1.5` on the root. The
    // measured-overflow guard only catches OVER-measurement, so if this constant ever drifts BELOW the
    // real packaged base (e.g. a Tailwind upgrade changing Preflight) the measure silently
    // UNDER-measures and landscape columns clip again — the exact D77 bug, with no other test to catch
    // it. This pin compiles a minimal doc through the REAL packager and fails the moment the compiled
    // Preflight base diverges from the constant the measure mirrors.
    const packaged = await new TailwindPackager().package({
      html: '<main class="text-text">Hi</main>',
      theme,
      items: [],
    });
    const css = packaged.match(/<style>([\s\S]*?)<\/style>/)?.[1] ?? "";
    // Tailwind v4 Preflight sets the base line-height on the root selector (`html, :host { … }`).
    const baseLineHeight = css.match(/html[^{]*\{[^}]*line-height:\s*([0-9.]+)/)?.[1];
    expect(baseLineHeight, "Tailwind Preflight must set a base root line-height").toBeDefined();
    expect(Number(baseLineHeight)).toBe(PACKAGED_BASE_LINE_HEIGHT);
  }, 60_000);

  it("defers the motion runtime until the DOM is parsed (the runtime <script> lives in <head>)", async () => {
    // Regression: the runtime <script data-motion-runtime> is emitted inside <head>, so querying
    // for [data-motion] elements synchronously would match nothing (body not yet parsed) and the
    // carousel/entrance motion would never start. It must wait for the DOM to be ready.
    const html = `<div data-motion="gallery-fade" data-motion-params="interval:5000;fade:800" class="text-text">Hi</div>`;
    const packaged = await new TailwindPackager().package({ html, theme, items: [] });

    expect(packaged).toContain("data-motion-runtime");
    // The glue guards its DOM work behind readyState/DOMContentLoaded rather than running at parse.
    expect(packaged).toContain("DOMContentLoaded");
    expect(packaged).toMatch(/readyState/);
    // And the runtime marker still sits in <head> (so the guard is what makes it correct).
    expect(packaged.indexOf("data-motion-runtime")).toBeLessThan(packaged.indexOf("<body"));
  }, 60_000);

  it("defines --color-sold in the packaged stylesheet for every bundled theme", async () => {
    // menu-cast's serve-time strike transform grays out sold-out items with
    // `var(--color-sold)` (menucast-integration I6). `@theme static` (D67) forces every declared
    // colour token into the packaged CSS regardless of whether the board's markup happens to use
    // it, so this holds for a MINIMAL board too — pin it so a theme edit or a packager change
    // can't silently drop the token menu-cast depends on.
    for (const presetId of Object.keys(BUNDLED_THEME_PRESETS)) {
      const html = await packageFixture(presetId);
      expect(html, presetId).toContain("--color-sold");
    }
  }, 60_000);
});
