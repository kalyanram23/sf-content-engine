import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";

import { defaultQaConfig } from "../config/qa";
import { defaultTokenLintRules } from "../config/token-lint";
import type { CanonicalItem, PlanScreen, ResolvedTheme } from "../domain/types";
import {
  checkBrandBinding,
  checkMotion,
  checkSelfContained,
  runStructuralChecks,
  type StructuralContext,
} from "./structural-checks";

const theme: ResolvedTheme = {
  id: "t",
  name: "Test",
  tokens: { colors: {}, fontFamilies: {}, radius: {} },
  motion: [
    { name: "stagger-in", kind: "css" },
    { name: "gallery-fade", kind: "runtime" },
  ],
  assets: { backgrounds: [], fonts: [] },
  density: "balanced",
};

const items: CanonicalItem[] = [
  {
    id: "id4",
    name: "Margherita",
    available: true,
    sizes: [
      { label: '8"', price: 8.99 },
      { label: '10"', price: 11.99 },
    ],
  },
  { id: "id7", name: "Pepperoni", available: true, price: 13.5 },
  {
    id: "id9",
    name: "Curry",
    available: true,
    variants: [{ label: "Veg" }, { label: "Paneer", price: 2 }, { label: "Chicken", price: 3 }],
  },
];

const planScreen: PlanScreen = {
  id: "screen-1",
  sections: [
    { title: "PIZZAS", representation: "matrix", items: ["id4"] },
    { title: "CLASSICS", representation: "list", items: ["id7"] },
    { title: "CURRIES", representation: "variant-rows", items: ["id9"] },
  ],
};

const VALID_HTML = `
<main>
  <section data-motion="stagger-in">
    <article class="menu-item" data-item-id="id4" data-available="true">
      <h3>Margherita</h3>
      <table>
        <tr><td>8"</td><td data-bind="price">$8.99</td></tr>
        <tr><td>10"</td><td data-bind="price">$11.99</td></tr>
      </table>
    </article>
    <article class="menu-item p-4" data-item-id="id7" data-available="true">
      <h3>Pepperoni</h3><span data-bind="price">$13.50</span>
    </article>
  </section>
  <section>
    <article data-item-id="id9" data-available="true">
      <h3>Curry</h3>
      <div>Veg <span data-bind="price">$0.00</span></div>
      <div>Paneer <span data-bind="price">$2.00</span></div>
      <div>Chicken <span data-bind="price">$3.00</span></div>
    </article>
  </section>
</main>`;

function ctx(html: string, overrides: Partial<StructuralContext> = {}): StructuralContext {
  return {
    html,
    planScreen,
    items,
    theme,
    qa: defaultQaConfig(),
    tokenLint: defaultTokenLintRules(),
    ...overrides,
  };
}

const kinds = (html: string, overrides?: Partial<StructuralContext>) =>
  runStructuralChecks(ctx(html, overrides)).map((f) => f.kind);

describe("runStructuralChecks — valid screen", () => {
  it("produces no findings for a correct, self-contained screen", () => {
    expect(runStructuralChecks(ctx(VALID_HTML))).toEqual([]);
  });
});

describe("binding integrity (§5.5)", () => {
  it("flags a missing planned item", () => {
    const html = VALID_HTML.replace(/<article class="menu-item p-4"[\s\S]*?<\/article>/, "");
    expect(kinds(html)).toContain("binding-missing");
  });

  it("flags a duplicated data-item-id", () => {
    const dup = `<article data-item-id="id7" data-available="true"><span data-bind="price">$13.50</span></article>`;
    expect(kinds(VALID_HTML.replace("</main>", `${dup}</main>`))).toContain("binding-duplicate");
  });

  it("flags a missing required data-bind hook", () => {
    const html = VALID_HTML.replace('<span data-bind="price">$13.50</span>', "<span>$13.50</span>");
    expect(kinds(html)).toContain("binding-hook-missing");
  });

  it("flags a price that does not match source", () => {
    const html = VALID_HTML.replace('data-bind="price">$13.50', 'data-bind="price">$99.00');
    expect(kinds(html)).toContain("binding-mismatch");
  });
});

describe("token-lint (§5.2) — every surface", () => {
  it("flags a raw hex in a class arbitrary-value", () => {
    expect(
      kinds(VALID_HTML.replace('class="menu-item"', 'class="menu-item text-[#ff0000]"')),
    ).toContain("token-lint");
  });

  it("flags a raw px in a class arbitrary-value", () => {
    expect(kinds(VALID_HTML.replace('class="menu-item"', 'class="menu-item p-[7px]"'))).toContain(
      "token-lint",
    );
  });

  it("flags a raw hex in an inline style", () => {
    expect(
      kinds(VALID_HTML.replace("<h3>Margherita</h3>", '<h3 style="color:#abc">Margherita</h3>')),
    ).toContain("token-lint");
  });

  it("flags a raw px inside a <style> block", () => {
    expect(kinds(VALID_HTML.replace("<main>", "<main><style>.x{margin:5px}</style>"))).toContain(
      "token-lint",
    );
  });

  it("does not flag allowed px values (0/1)", () => {
    expect(
      kinds(VALID_HTML.replace("<main>", "<main><style>.x{border:1px}</style>")),
    ).not.toContain("token-lint");
  });

  it("flags a raw hex in an SVG fill attribute (painter-authored decoration)", () => {
    const svg = '<svg aria-hidden="true"><path fill="#abcdef" d="M0 0h10v10z"/></svg>';
    expect(kinds(VALID_HTML.replace("<main>", `<main>${svg}`))).toContain("token-lint");
  });

  it("flags a raw hex in an SVG stroke attribute", () => {
    const svg = '<svg aria-hidden="true"><path stroke="#fff" d="M0 0h10v10z"/></svg>';
    expect(kinds(VALID_HTML.replace("<main>", `<main>${svg}`))).toContain("token-lint");
  });

  it("does not flag SVG decoration coloured with theme tokens or currentColor", () => {
    const svg =
      '<svg aria-hidden="true"><path fill="var(--color-accent)" stroke="currentColor" d="M0 0h10v10z"/></svg>';
    expect(kinds(VALID_HTML.replace("<main>", `<main>${svg}`))).not.toContain("token-lint");
  });

  it("flags a raw px in an inline style on a content element", () => {
    expect(
      kinds(
        VALID_HTML.replace("<h3>Margherita</h3>", '<h3 style="font-size:20px">Margherita</h3>'),
      ),
    ).toContain("token-lint");
  });

  it("does not flag raw px in inline style inside aria-hidden SVG decoration (e.g. a ghost word)", () => {
    const svg =
      '<svg aria-hidden="true"><text style="font-size:260px" fill="var(--color-surface)">FEAST</text></svg>';
    expect(kinds(VALID_HTML.replace("<main>", `<main>${svg}`))).not.toContain("token-lint");
  });

  it("still flags a raw hex in inline style inside decorative SVG (px is exempt, colour is not)", () => {
    const svg = '<svg aria-hidden="true"><text style="color:#abc">FEAST</text></svg>';
    expect(kinds(VALID_HTML.replace("<main>", `<main>${svg}`))).toContain("token-lint");
  });
});

describe("motion-vocab (§5.2/D14)", () => {
  it("flags a data-motion outside the theme vocabulary", () => {
    expect(kinds(VALID_HTML.replace('data-motion="stagger-in"', 'data-motion="zoomy"'))).toContain(
      "motion-vocab",
    );
  });

  it("flags runtime motion when the Motion runtime is not inlined", () => {
    expect(
      kinds(VALID_HTML.replace('data-motion="stagger-in"', 'data-motion="gallery-fade"')),
    ).toContain("motion-vocab");
  });

  it("passes runtime motion when the runtime is inlined", () => {
    const html = VALID_HTML.replace(
      'data-motion="stagger-in"',
      'data-motion="gallery-fade"',
    ).replace("</main>", "<script data-motion-runtime>/* motion */</script></main>");
    expect(kinds(html)).not.toContain("motion-vocab");
  });
});

describe("self-contained + no baked player (§5.1)", () => {
  it("flags an external src", () => {
    expect(
      kinds(VALID_HTML.replace("<h3>Curry</h3>", '<h3>Curry</h3><img src="https://cdn/x.png">')),
    ).toContain("self-contained");
  });

  it("allows a data-URI src", () => {
    expect(
      kinds(
        VALID_HTML.replace("<h3>Curry</h3>", '<h3>Curry</h3><img src="data:image/png;base64,AAA">'),
      ),
    ).not.toContain("self-contained");
  });

  it("flags an external url() in a style block", () => {
    expect(
      kinds(
        VALID_HTML.replace("<main>", "<main><style>.bg{background:url(http://cdn/x.png)}</style>"),
      ),
    ).toContain("self-contained");
  });

  it("flags a meta refresh and script navigation as a baked player", () => {
    expect(
      kinds(VALID_HTML.replace("<main>", '<main><meta http-equiv="refresh" content="5">')),
    ).toContain("baked-player");
    expect(
      kinds(VALID_HTML.replace("</main>", "<script>location.href='/next'</script></main>")),
    ).toContain("baked-player");
  });
});

describe("capacity → re-plan signal (§5.6/S1)", () => {
  it("flags a section that exceeds its representation capacity", () => {
    const crowded: PlanScreen = {
      id: "screen-1",
      sections: [
        { title: "PIZZAS", representation: "matrix", items: ["a", "b", "c", "d", "e", "f", "g"] },
      ],
    };
    const found = runStructuralChecks(ctx(VALID_HTML, { planScreen: crowded }));
    expect(found.map((f) => f.kind)).toContain("overflow-capacity");
  });
});

describe("representation oracle (acceptance #3, §7)", () => {
  it("flags a matrix missing a size cell", () => {
    const html = VALID_HTML.replace('<tr><td>10"</td><td data-bind="price">$11.99</td></tr>', "");
    // now only 1 price hook for id4 which has 2 sizes; also a price-mismatch is expected
    expect(kinds(html)).toContain("representation");
  });

  it("flags variant-rows missing a variant", () => {
    const html = VALID_HTML.replace('<div>Chicken <span data-bind="price">$3.00</span></div>', "");
    expect(kinds(html)).toContain("representation");
  });
});

describe("malformed HTML resilience", () => {
  it("still detects a missing binding in unclosed markup", () => {
    const malformed = `<main><article data-item-id="id4"><h3>Margherita<table><tr><td data-bind="price">$8.99</td>`;
    const found = kinds(malformed);
    // id7 and id9 are absent → binding-missing; id4 matrix lacks a 2nd price cell
    expect(found).toContain("binding-missing");
  });
});

describe("runtime carousel motion (gallery-fade) is offline-safe", () => {
  // The vanilla motion.dev runtime is inlined as a <script data-motion-runtime> that drives the
  // carousel with setInterval + animate (never navigation), over data-URI photos.
  const carousel =
    `<div data-motion="gallery-fade" data-motion-params="interval:5000;fade:800">` +
    `<img src="data:image/png;base64,AAAA"><img src="data:image/png;base64,AAAA"></div>`;
  const runtime =
    `<script data-motion-runtime>(function(){var M=globalThis.__ceMotion;if(!M)return;` +
    `document.querySelectorAll('[data-motion="gallery-fade"]').forEach(function(r){` +
    `setInterval(function(){M.animate(r,{opacity:[1,0]},{duration:0.8});},5000);});})();</script>`;

  it("passes motion-vocab (runtime marker present) and self-contained (no external/baked-player)", () => {
    const root = parse(`<main>${carousel}${runtime}</main>`);
    expect(checkMotion(root, ctx(""))).toEqual([]);
    expect(checkSelfContained(root)).toEqual([]);
  });

  it("flags a data-motion runtime preset when the [data-motion-runtime] marker is missing", () => {
    const root = parse(`<main>${carousel}</main>`);
    expect(checkMotion(root, ctx("")).length).toBeGreaterThan(0);
  });

  it("flags a script that performs navigation as a baked player", () => {
    const root = parse(
      `<main><script data-motion-runtime>window.location.href='/next';</script></main>`,
    );
    expect(checkSelfContained(root).some((f) => f.kind === "baked-player")).toBe(true);
  });
});

describe("checkBrandBinding", () => {
  const ctxWith = (extra: object) =>
    ({
      planScreen: { id: "s", sections: [] },
      items: [],
      theme: {},
      qa: {},
      tokenLint: {},
      ...extra,
    }) as never;

  it("no findings when no brand logo was requested", () => {
    const root = parse("<main></main>");
    expect(checkBrandBinding(root, ctxWith({ brandLogoRequested: false }))).toHaveLength(0);
  });

  it("flags a requested logo that was not rendered", () => {
    const root = parse("<main><h1>Menu</h1></main>");
    const found = checkBrandBinding(root, ctxWith({ brandLogoRequested: true }));
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("brand-binding");
  });

  it("passes when the placeholder carries an inlined data-URI src", () => {
    const root = parse('<main><img data-brand-logo src="data:image/png;base64,AAAA"></main>');
    expect(checkBrandBinding(root, ctxWith({ brandLogoRequested: true }))).toHaveLength(0);
  });

  it("flags a placeholder that leaked a non-inlined src", () => {
    const root = parse('<main><img data-brand-logo src="https://x/logo.png"></main>');
    const found = checkBrandBinding(root, ctxWith({ brandLogoRequested: true }));
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("brand-binding");
  });
});
