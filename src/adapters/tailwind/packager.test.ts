import { describe, expect, it } from "vitest";

import type { CanonicalItem } from "../../domain/types";
import { resolveTheme } from "../../theme/resolve";
import { botanicalPreset } from "../../theme/presets/botanical";
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
