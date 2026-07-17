import { parse } from "node-html-parser";
import { describe, expect, it } from "vitest";

import { defaultQaConfig } from "../config/qa";
import { defaultTokenLintRules } from "../config/token-lint";
import type { CanonicalItem, PlanScreen, ResolvedTheme } from "../domain/types";
import {
  checkBindings,
  checkBrandBinding,
  checkImageSlots,
  checkMotion,
  checkPricePresent,
  checkSelfContained,
  isComposedHtml,
  runStructuralChecks,
  type StructuralContext,
} from "./structural-checks";
import { FakePainter } from "../testing/fakes/painter";
import type { PaintRequest } from "../ports/painter";
import { dhabaVocabulary } from "../vocabularies/dhaba";

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
      <h3>Margherita</h3><span data-bind="name">Margherita</span>
      <table>
        <tr><td>8"</td><td data-bind="price" data-size="8&quot;">$8.99</td></tr>
        <tr><td>10"</td><td data-bind="price" data-size="10&quot;">$11.99</td></tr>
      </table>
    </article>
    <article class="menu-item p-4" data-item-id="id7" data-available="true">
      <h3>Pepperoni</h3><span data-bind="name">Pepperoni</span><span data-bind="price">$13.50</span>
    </article>
  </section>
  <section>
    <article data-item-id="id9" data-available="true">
      <h3>Curry</h3><span data-bind="name">Curry</span>
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

/** Drive `checkBindings` in isolation with a one-section list plan over the given ids/items. */
const runCheckBindings = (
  html: string,
  opts: { items: CanonicalItem[]; plannedIds: string[]; requiredBindings?: string[] },
) => {
  const plan: PlanScreen = {
    id: "s",
    sections: [{ title: "S", representation: "list", items: opts.plannedIds }],
  };
  const qa =
    opts.requiredBindings !== undefined
      ? { ...defaultQaConfig(), requiredBindings: opts.requiredBindings }
      : defaultQaConfig();
  return checkBindings(parse(html), ctx(html, { items: opts.items, planScreen: plan, qa }));
};

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

  it("flags a sized item whose size span is missing or mistagged", () => {
    const html = `<div data-item-id="sz1"><span data-bind="name">X</span>
    <span data-bind="price" data-size="Half">Half $6.50</span>
    <span data-bind="price">$11.00</span></div>`; // Full untagged
    const findings = runCheckBindings(html, {
      items: [
        {
          id: "sz1",
          name: "X",
          available: true,
          sizes: [
            { label: "Half", price: 6.5 },
            { label: "Full", price: 11 },
          ],
        },
      ],
      plannedIds: ["sz1"],
    });
    expect(findings.map((f) => f.kind)).toContain("binding-mismatch");
    expect(findings.find((f) => f.kind === "binding-mismatch")!.message).toContain('"Full"');
  });

  it("flags an item missing its data-bind=name hook", () => {
    const html = `<div data-item-id="n1"><b>Dosa</b>
    <span data-bind="price">$5.00</span></div>`;
    const findings = runCheckBindings(html, {
      items: [{ id: "n1", name: "Dosa", available: true, price: 5 }],
      plannedIds: ["n1"],
      requiredBindings: ["price", "name"],
    });
    expect(findings.map((f) => f.kind)).toContain("binding-hook-missing");
  });

  it("accepts a matrix item whose name lives on the row label", () => {
    const html = `<div data-matrix><div data-matrix-row="Chicken Dum">
    <div><span data-bind="name">Chicken Dum</span></div>
    <div data-matrix-cell="Biryani" data-item-id="m1" data-available="true">
      <span data-bind="price" data-size="Biryani">$9.00</span></div></div></div>`;
    const findings = runCheckBindings(html, {
      items: [{ id: "m1", name: "Chicken Dum Biryani", available: true, price: 9 }],
      plannedIds: ["m1"],
      requiredBindings: ["price", "name"],
    });
    expect(findings).toEqual([]);
  });

  it("passes a sized item with one correctly tagged span per size", () => {
    const html = `<div data-item-id="sz1"><span data-bind="name">X</span>
    <span data-bind="price" data-size="Half">Half $6.50</span>
    <span data-bind="price" data-size="Full">Full $11.00</span></div>`;
    const findings = runCheckBindings(html, {
      items: [
        {
          id: "sz1",
          name: "X",
          available: true,
          sizes: [
            { label: "Half", price: 6.5 },
            { label: "Full", price: 11 },
          ],
        },
      ],
      plannedIds: ["sz1"],
    });
    expect(findings).toEqual([]);
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

  // Composed-board trust (D73): deterministic vocabulary output owns its px/hex by construction —
  // the lint's target is LLM-authored markup, so a root carrying data-composed is skipped even with
  // raw hex + raw px present. Free-paint (no marker) still fires — the non-regression pin.
  it("SKIPS markup whose root carries data-composed (deterministic renderer output, D73)", () => {
    const html = `<div data-composed="dhaba@1"><div style="color:#c22415;font-size:19px">x</div></div>`;
    expect(kinds(html)).not.toContain("token-lint");
  });

  it("still fires on the SAME markup without the composed marker (non-regression pin)", () => {
    const html = `<div><div style="color:#c22415;font-size:19px">x</div></div>`;
    expect(kinds(html)).toContain("token-lint");
  });
});

describe("isComposedHtml (composed-root marker, D73)", () => {
  it("is true when the ROOT element carries data-composed", () => {
    expect(isComposedHtml(`<div data-composed="dhaba@1"><p>x</p></div>`)).toBe(true);
  });

  it("tolerates leading whitespace before the root element", () => {
    expect(isComposedHtml(`\n  <div data-composed="dhaba@1">a</div>`)).toBe(true);
  });

  it("is false for free-paint markup with no marker", () => {
    expect(isComposedHtml(`<main><section>x</section></main>`)).toBe(false);
  });

  it("is false when data-composed appears only on a NON-root descendant", () => {
    expect(isComposedHtml(`<main><div data-composed="dhaba@1">x</div></main>`)).toBe(false);
  });

  // deterministicQA feeds the checks the PACKAGED document (packager wraps the fragment in
  // <!doctype html><html>…<body>{fragment}</body>) — the marker must be found inside <body>.
  it("is true for a PACKAGED document whose <body> first child carries data-composed", () => {
    const doc = `<!doctype html><html lang="en"><head></head><body><div data-composed="dhaba@1"><p>x</p></div></body></html>`;
    expect(isComposedHtml(doc)).toBe(true);
  });

  it("is false for a PACKAGED free-paint document with no marker", () => {
    const doc = `<!doctype html><html lang="en"><head></head><body><main><section>x</section></main></body></html>`;
    expect(isComposedHtml(doc)).toBe(false);
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
    const html = VALID_HTML.replace(
      '<tr><td>10"</td><td data-bind="price" data-size="10&quot;">$11.99</td></tr>',
      "",
    );
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

describe("price-present check (Fix 2 — 'prices properly there')", () => {
  const priced: CanonicalItem[] = [{ id: "x", name: "Dosa", available: true, price: 10 }];
  const pricedPlan: PlanScreen = {
    id: "s",
    sections: [{ title: "Tiffins", representation: "list", items: ["x"] }],
  };
  const pctx = (html: string, over: Partial<StructuralContext> = {}) =>
    ctx(html, { items: priced, planScreen: pricedPlan, ...over });

  it("fires when a priced item's data-bind=price span is empty (whitespace only)", () => {
    const html = `<main><article data-item-id="x"><span data-bind="price">   </span></article></main>`;
    const found = checkPricePresent(parse(html), pctx(html));
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({
      kind: "price-missing",
      source: "deterministic",
      severity: "major",
      tag: "content",
      itemId: "x",
    });
    expect(found[0]!.deterministicallyFixable).toBe(false);
  });

  it("fires when a priced item has no price span at all", () => {
    const html = `<main><article data-item-id="x"><h3>Dosa</h3></article></main>`;
    expect(checkPricePresent(parse(html), pctx(html)).map((f) => f.kind)).toEqual([
      "price-missing",
    ]);
  });

  it("passes a priced item whose data-bind=price span carries text", () => {
    const html = `<main><article data-item-id="x"><span data-bind="price">$10.00</span></article></main>`;
    expect(checkPricePresent(parse(html), pctx(html))).toHaveLength(0);
  });

  it("never fires for an item with no price in the source (menu-lint hides those)", () => {
    const unpriced: CanonicalItem[] = [{ id: "y", name: "Water", available: true }];
    const plan: PlanScreen = {
      id: "s",
      sections: [{ title: "Free", representation: "list", items: ["y"] }],
    };
    const html = `<main><article data-item-id="y"><h3>Water</h3></article></main>`;
    expect(
      checkPricePresent(parse(html), ctx(html, { items: unpriced, planScreen: plan })),
    ).toHaveLength(0);
  });

  it("never fires on a matrix em-dash cell for a column the item does not have", () => {
    // b-egg (priced) is filled in the Biryani column (with a price span) and an em-dash in Pulav.
    const matrixItems: CanonicalItem[] = [
      { id: "b-egg", name: "Egg Biryani", category: "Biryani", available: true, price: 10 },
    ];
    const plan: PlanScreen = {
      id: "s",
      sections: [
        {
          title: "Biryani & Pulav",
          representation: "matrix",
          items: ["b-egg"],
          matrix: {
            columns: ["Biryani", "Pulav"],
            rows: [{ label: "Egg", cells: ["b-egg", null] }],
          },
        },
      ],
    };
    const html =
      `<main><div data-matrix><div data-matrix-row="Egg"><span>Egg</span>` +
      `<div data-matrix-cell="Biryani" data-item-id="b-egg"><span data-bind="price">$10.00</span></div>` +
      `<div data-matrix-cell="Pulav">—</div></div></div></main>`;
    expect(
      checkPricePresent(parse(html), ctx(html, { items: matrixItems, planScreen: plan })),
    ).toHaveLength(0);
  });

  it("surfaces through runStructuralChecks", () => {
    const html = `<main><article data-item-id="x"><h3>Dosa</h3></article></main>`;
    expect(runStructuralChecks(pctx(html)).map((f) => f.kind)).toContain("price-missing");
  });
});

describe("checkImageSlots (Fix 4 — category image slots enforced engine-side)", () => {
  const sectionSlotPlan: PlanScreen = {
    id: "s",
    sections: [
      {
        title: "MANDI",
        representation: "grid",
        items: ["a"],
        imageSlot: { kind: "photos", items: ["a"] },
      },
      {
        title: "DESSERTS",
        representation: "grid",
        items: ["b"],
        imageSlot: { kind: "icon", items: [] },
      },
    ],
  };

  it("fires per missing section slot, naming the category", () => {
    const html = `<main><article data-item-id="a"></article><article data-item-id="b"></article></main>`;
    const found = checkImageSlots(ctx(html, { planScreen: sectionSlotPlan }));
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.kind)).toEqual(["image-slot-missing", "image-slot-missing"]);
    expect(found.map((f) => f.region)).toEqual(["MANDI", "DESSERTS"]);
    expect(found[0]).toMatchObject({ severity: "major", tag: "content", source: "deterministic" });
    expect(found[0]!.deterministicallyFixable).toBe(false);
  });

  it("stays quiet when every planned section slot is present", () => {
    const html = `<main><div data-image-slot="MANDI"></div><div data-image-slot="DESSERTS"></div></main>`;
    expect(checkImageSlots(ctx(html, { planScreen: sectionSlotPlan }))).toHaveLength(0);
  });

  it("only the missing section fires when one slot is present and the other absent", () => {
    const html = `<main><div data-image-slot="MANDI"></div></main>`;
    const found = checkImageSlots(ctx(html, { planScreen: sectionSlotPlan }));
    expect(found).toHaveLength(1);
    expect(found[0]!.region).toBe("DESSERTS");
  });

  it("fires when a planned board-level shared slot is missing, and clears when present", () => {
    const sharedPlan: PlanScreen = {
      id: "s",
      imageSlot: { items: ["a"] },
      sections: [{ title: "MAINS", representation: "list", items: ["a"] }],
    };
    const missing = checkImageSlots(
      ctx("<main><section></section></main>", { planScreen: sharedPlan }),
    );
    expect(missing).toHaveLength(1);
    expect(missing[0]!.kind).toBe("image-slot-missing");
    const present = `<main><div data-image-slot="shared"></div></main>`;
    expect(checkImageSlots(ctx(present, { planScreen: sharedPlan }))).toHaveLength(0);
  });

  it("exempts a plan whose sections carry no image slots (and no shared slot)", () => {
    // The default planScreen fixture has neither → the check is a no-op, never a false positive.
    expect(checkImageSlots(ctx(VALID_HTML))).toHaveLength(0);
  });

  // D73-class trust: a composed board (data-composed root) renders photo BANDS only; a photo-LESS
  // `icon` slot has no vocabulary-v1 component, so it is skipped for composed roots. Photo slots stay
  // enforced; free-paint boards are unaffected.
  it("composed board: skips a photo-LESS `icon` section slot but still enforces the photo slot", () => {
    // MANDI (photos) is satisfied by the shared band's marker; DESSERTS (icon) is trusted away → clean.
    const html = `<div data-composed="dhaba@1"><div data-image-slot="MANDI"></div></div>`;
    expect(checkImageSlots(ctx(html, { planScreen: sectionSlotPlan }))).toHaveLength(0);
  });

  it("composed board: a MISSING photo section slot still fires (icon skip never weakens photo slots)", () => {
    const html = `<div data-composed="dhaba@1"></div>`;
    const found = checkImageSlots(ctx(html, { planScreen: sectionSlotPlan }));
    expect(found).toHaveLength(1);
    expect(found[0]!.region).toBe("MANDI"); // DESSERTS (icon) skipped; MANDI (photos) enforced
  });

  it("free-paint board: an `icon` slot is STILL enforced (composed-only trust — non-regression pin)", () => {
    // Same plan + same missing markup, but a NON-composed root → BOTH slots fire, exactly as before.
    const html = `<main><article data-item-id="a"></article><article data-item-id="b"></article></main>`;
    const found = checkImageSlots(ctx(html, { planScreen: sectionSlotPlan }));
    expect(found.map((f) => f.region)).toEqual(["MANDI", "DESSERTS"]);
  });

  it("composed board: a slot title with a literal quote round-trips (emitter escape ↔ matcher, no false image-slot-missing)", () => {
    // End-to-end sync check: the dhaba EMITTER stamps data-image-slot with esc(); checkImageSlots
    // recomputes the expected value with escapeSlotTitle(). Both must escape `"` → &quot; identically,
    // or the slot-marker regex (which stops at the first `"`) reads a truncated value and false-fires
    // image-slot-missing on a perfectly-rendered composed board.
    const title = 'The "Big" Board';
    const band = dhabaVocabulary.renderPhotoBand({
      items: [{ id: "q0", name: "Combo", price: 9, hasImage: true, slot: title }],
      register: "M",
      bandHeight: 300,
      bandWidth: 976,
      mode: "filmstrip",
      uid: "q1",
    });
    const composed = `<div data-composed="dhaba@1">${band}</div>`;
    const plan: PlanScreen = {
      id: "s",
      sections: [
        {
          title,
          representation: "grid",
          items: ["q0"],
          imageSlot: { kind: "photos", items: ["q0"] },
        },
      ],
    };
    expect(checkImageSlots(ctx(composed, { planScreen: plan }))).toHaveLength(0);
  });

  it("passes the FakePainter's rendered output (it renders a container per planned slot, D38)", async () => {
    const plan: PlanScreen = {
      id: "s",
      imageSlot: { items: ["a"] },
      sections: sectionSlotPlan.sections,
    };
    const slotItems: CanonicalItem[] = [
      {
        id: "a",
        name: "Chicken Mandi",
        available: true,
        price: 12,
        images: ["data:image/png;base64,AAAA"],
      },
      { id: "b", name: "Kunafa", available: true, price: 8 },
    ];
    const html = await new FakePainter().paint({
      planScreen: plan,
      items: slotItems,
    } as unknown as PaintRequest);
    expect(checkImageSlots(ctx(html, { planScreen: plan, items: slotItems }))).toHaveLength(0);
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
