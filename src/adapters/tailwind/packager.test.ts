import { describe, expect, it } from "vitest";

import type { CanonicalItem } from "../../domain/types";
import { resolveTheme } from "../../theme/resolve";
import { botanicalPreset } from "../../theme/presets/botanical";
import { ICON_GLYPHS } from "../../theme/icon-glyphs";
import { checkSelfContained } from "../../qa/structural-checks";
import { PLACEHOLDER_IMAGE_DATA_URI } from "../../util/placeholder-image";
import { parse } from "node-html-parser";
import { TailwindPackager } from "./packager";

const theme = resolveTheme(botanicalPreset, { presetId: "botanical" });

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
});
