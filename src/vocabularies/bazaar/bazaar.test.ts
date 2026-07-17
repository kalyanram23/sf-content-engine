import { describe, expect, it } from "vitest";

import { describeVocabularyContract } from "../shared/contract.testkit";
import { bazaarVocabulary } from "./index";

// The full engine contract (bindings, escaping, settled carousels, density, token purity).
describeVocabularyContract(bazaarVocabulary);

const PORTRAIT = { width: 1080, height: 1920 };
const LANDSCAPE = { width: 1920, height: 1080 };

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `i${i}`,
    name: `Dish ${i}`,
    price: 9.99,
    hasImage: true,
  }));

const section = (n = 5) => ({ title: "Small Plates", items: items(n) });

/** Every themed render surface, for whole-output assertions. */
const allOutputs = () => [
  bazaarVocabulary.renderShell({
    title: "Tandoor & Tonic",
    tagline: "Street kitchen",
    canvas: PORTRAIT,
    register: "M",
    bodyHtml: "",
  }),
  bazaarVocabulary.renderShell({
    title: "Tandoor & Tonic",
    tagline: null,
    canvas: LANDSCAPE,
    register: "M",
    bodyHtml: "",
  }),
  bazaarVocabulary.renderSection({
    number: 1,
    section: section(),
    internalCols: 1,
    register: "M",
  }),
  bazaarVocabulary.renderGroup({
    startNumber: 1,
    sections: [section(3), { title: "Coolers", items: items(2) }],
    register: "M",
  }),
  bazaarVocabulary.renderPhotoBand({
    items: items(3),
    register: "M",
    bandHeight: 260,
    bandWidth: 992,
    mode: "filmstrip",
    uid: "b1",
  }),
  bazaarVocabulary.renderFlowLead({ number: 2, section: section(), register: "M" }),
  bazaarVocabulary.renderFlowRow({ item: items(2)[1]!, register: "M" }),
  bazaarVocabulary.renderContinuationCue({ sectionTitle: "Small Plates", register: "M" }),
];

describe("bazaarVocabulary — theme specifics", () => {
  it("every shadow is either the hard rem+var offset or the 3px ink outline ring — no blur, no rgba, no px offsets", () => {
    let shadows = 0;
    for (const html of allOutputs()) {
      for (const m of html.matchAll(/box-shadow:([^;"]+)/g)) {
        for (const part of m[1]!.split(",")) {
          shadows++;
          expect(part.trim()).toMatch(
            /^(\d*\.?\d+rem \d*\.?\d+rem 0 var\(--color-[a-z-]+\)|0 0 0 3px var\(--color-[a-z-]+\))$/,
          );
        }
      }
    }
    expect(shadows).toBeGreaterThan(0); // the depth system exists — panels actually cast shadows
  });

  it("emits no rgba() literal anywhere (low-alpha inks are color-mix over tokens)", () => {
    for (const html of allOutputs()) expect(html).not.toContain("rgba(");
  });

  it("section panels wear the 5px ink border + 0.625rem hard shadow and tilt ≤1deg, alternating by section number", () => {
    const at = (n: number): string =>
      bazaarVocabulary.renderSection({
        number: n,
        section: section(),
        internalCols: 1,
        register: "M",
      });
    for (const n of [1, 2, 3, 4]) {
      const html = at(n);
      expect(html).toContain("border:5px solid var(--color-text)");
      expect(html).toContain("box-shadow:0.625rem 0.625rem 0 var(--color-text)");
      // EVEN numbers lean right (+0.8deg), ODD lean left (−0.8deg) — deterministic, never past 1deg.
      expect(html).toContain(`transform:rotate(${n % 2 === 0 ? "" : "-"}0.8deg)`);
      for (const m of html.matchAll(/rotate\((-?\d*\.?\d+)deg\)/g)) {
        expect(Math.abs(Number(m[1]))).toBeLessThanOrEqual(1);
      }
    }
  });

  it("section headers are Anton all-caps ink with a short thick chili-red underline + ink number chip", () => {
    const html = bazaarVocabulary.renderSection({
      number: 3,
      section: { title: "Tandoor Mains", items: items(4) },
      internalCols: 1,
      register: "L",
    });
    expect(html).toContain("'Anton',sans-serif");
    expect(html).toContain("text-transform:uppercase");
    expect(html).toContain("width:90px;height:6px;background:var(--color-accent)"); // the red bar
    expect(html).toContain("background:var(--color-text)"); // ink number chip backing
    expect(html).toContain("03"); // zero-padded number
  });

  it("price chips: bordered 2px ink on surface-strong, bold price ink; null price → the same chip with MP", () => {
    const html = bazaarVocabulary.renderSection({
      number: 1,
      section: {
        title: "Small Plates",
        items: [
          { id: "a", name: "Paneer 65", price: 12.5, hasImage: false },
          { id: "b", name: "Market Fish", price: null, hasImage: false },
        ],
      },
      internalCols: 1,
      register: "M",
    });
    const chips = [...html.matchAll(/data-bind="price" style="([^"]*)">([^<]*)</g)];
    expect(chips).toHaveLength(2);
    for (const [, style] of chips) {
      expect(style).toContain("border:2px solid var(--color-text)");
      expect(style).toContain("background:var(--color-surface-strong)");
      expect(style).toContain("color:var(--color-price)");
      expect(style).toContain("font-weight:700");
    }
    expect(chips[0]![2]).toBe("$12.50");
    expect(chips[1]![2]).toBe("MP"); // market price rides the SAME chip
  });

  it("photo cards are circle stickers: 50% radius, thick cream border, ink ring + hard offset, ±2deg alternating tilt, caption chip in the same element", () => {
    const html = bazaarVocabulary.renderPhotoBand({
      items: items(3),
      register: "M",
      bandHeight: 260,
      bandWidth: 992,
      mode: "static",
      uid: "b1",
    });
    expect(html).toContain("border-radius:50%");
    expect(html).toContain("border:8px solid var(--color-surface)"); // thick cream sticker border
    expect(html).toContain(
      "box-shadow:0 0 0 3px var(--color-text),0.5rem 0.5rem 0 var(--color-text)",
    );
    expect(html).toContain("transform:rotate(2deg)"); // sticker 0 leans right…
    expect(html).toContain("transform:rotate(-2deg)"); // …sticker 1 leans left
    // Caption chip: bordered cream chip inside the SAME card element (carousels can't split them).
    expect(html).toContain("border:2px solid var(--color-text)");
    expect(html).toContain("Dish 0");
    // One red starburst by the first sticker — decoration only, no text.
    expect([...html.matchAll(/fill="var\(--color-accent\)"/g)]).toHaveLength(1);
  });

  it("stickers stay 1:1 — the circle box is square at every band height (growth keeps the circle)", () => {
    for (const bandHeight of [220, 300, 420]) {
      const html = bazaarVocabulary.renderPhotoBand({
        items: items(2),
        register: "M",
        bandHeight,
        bandWidth: 992,
        mode: "static",
        uid: "b1",
      });
      const m = /width:(\d+)px;height:(\d+)px;border-radius:50%/.exec(html);
      expect(m).not.toBeNull();
      expect(m![1]).toBe(m![2]);
    }
  });

  it("groups: 2–3 small sections inside ONE cream panel, divided by 2px ink rules, small Anton headers with red underlines", () => {
    const html = bazaarVocabulary.renderGroup({
      startNumber: 4,
      sections: [section(3), { title: "Coolers", items: items(2) }],
      register: "M",
    });
    // one shared panel frame + shadow…
    expect([
      ...html.matchAll(/box-shadow:0\.625rem 0\.625rem 0 var\(--color-text\)/g),
    ]).toHaveLength(1);
    expect([...html.matchAll(/border:5px solid var\(--color-text\)/g)]).toHaveLength(1);
    // …divided by a 2px ink rule, with a small red underline per member
    expect(html).toContain("border-left:2px solid var(--color-text)");
    expect([
      ...html.matchAll(/width:60px;height:4px;background:var\(--color-accent\)/g),
    ]).toHaveLength(2);
    expect(html).toContain("04");
    expect(html).toContain("05");
    // the shared panel tilts with the first member's (even) number
    expect(html).toContain("transform:rotate(0.8deg)");
  });

  it("header is ONE slim compact row: 150px portrait / 104px landscape, cream Anton title, logo on an ink chip", () => {
    const shell = (canvas: { width: number; height: number }): string =>
      bazaarVocabulary.renderShell({
        title: "Tandoor & Tonic",
        tagline: "Street kitchen",
        canvas,
        register: "M",
        bodyHtml: "",
        brand: { logo: { src: "ignored.png" }, name: "Tandoor & Tonic" },
      });
    const portrait = shell(PORTRAIT);
    expect(portrait).toContain("height:150px");
    const landscape = shell(LANDSCAPE);
    expect(landscape).toContain("height:104px");
    for (const html of [portrait, landscape]) {
      expect(html).toContain("color:var(--color-surface)"); // cream title on the orange ground
      // the logo's dark backing chip wraps the placeholder
      expect(html).toMatch(/background:var\(--color-text\);[^"]*"[^>]*>\s*<img data-brand-logo/);
    }
    // No brand → a bordered cream placeholder box instead.
    const bare = bazaarVocabulary.renderShell({
      title: "Board",
      tagline: null,
      canvas: PORTRAIT,
      register: "M",
      bodyHtml: "",
    });
    expect(bare).toContain("border:3px solid var(--color-surface)");
  });

  it("portrait contentBox: header (150) + top pad stay within a tenth of the canvas (≤192px); exact box", () => {
    const box = bazaarVocabulary.contentBox(PORTRAIT);
    // 1080 − 2×44 side margins; 1920 − 150 header − 24 top − 36 bottom
    expect(box).toEqual({ width: 992, height: 1710 });
    expect(150 + 24).toBeLessThanOrEqual(192); // identity: header never past ~a tenth of the canvas
  });

  it("landscape shell wraps the body in ONE cream panel (no tilt); portrait panels sit directly on orange", () => {
    const shell = (canvas: { width: number; height: number }): string =>
      bazaarVocabulary.renderShell({
        title: "Board",
        tagline: null,
        canvas,
        register: "M",
        bodyHtml: "<div>BODY</div>",
        brand: { logo: { src: "ignored.png" }, name: "Tandoor & Tonic" },
      });
    const landscape = shell(LANDSCAPE);
    expect(landscape).toMatch(
      /background:var\(--color-surface\);border:5px solid var\(--color-text\);box-shadow:0\.625rem 0\.625rem 0 var\(--color-text\);[^"]*"[^>]*><div>BODY<\/div>/,
    );
    expect(landscape).not.toContain("transform:rotate(0.8deg)"); // the big panel never tilts
    // Portrait: the sections are already panels — the shell adds no panel of its own.
    const portrait = shell(PORTRAIT);
    expect(portrait).not.toContain("border:5px solid var(--color-text)");
    expect(portrait).toContain("<div>BODY</div>");
  });

  it("landscape contentBox subtracts the body panel chrome exactly and still affords 4 columns at 420px", () => {
    const box = bazaarVocabulary.contentBox(LANDSCAPE);
    // 1920 − 2×26 margins − 2×5 border − 2×22 panel padding; 1080 − 104 header − 16 − 22 − 10 − 44
    expect(box).toEqual({ width: 1814, height: 884 });
    const fourColWidth = Math.floor((box.width - 3 * 44) / 4);
    expect(fourColWidth).toBeGreaterThanOrEqual(bazaarVocabulary.minStreamWidth);
  });

  it("ground decor: ONE cream zigzag divider + sparse cream dot texture, palette-only SVG", () => {
    const html = bazaarVocabulary.renderShell({
      title: "Board",
      tagline: null,
      canvas: PORTRAIT,
      register: "M",
      bodyHtml: "",
    });
    expect([...html.matchAll(/stroke="var\(--color-surface\)"/g)]).toHaveLength(1); // one zigzag
    expect(html).toContain("color-mix(in srgb,var(--color-surface) 30%,transparent)"); // dot ink
    expect(html).toContain("<circle");
  });

  it("continuation cue: Archivo bold italic muted ink with a thin soft rule", () => {
    const cue = bazaarVocabulary.renderContinuationCue({
      sectionTitle: "Tandoor Mains",
      register: "M",
    });
    expect(cue).toContain("font-style:italic");
    expect(cue).toContain("font-weight:700");
    expect(cue).toContain("color:var(--color-muted)");
    expect(cue).toContain("Tandoor Mains (cont.)");
  });

  it("header shrinks long titles to one line in Anton", () => {
    const size = (title: string): number =>
      Number(
        /font-family:'Anton',sans-serif;font-size:(\d+)px/.exec(
          bazaarVocabulary.renderShell({
            title,
            tagline: null,
            canvas: PORTRAIT,
            register: "M",
            bodyHtml: "",
          }),
        )?.[1],
      );
    expect(size("Tiffin")).toBe(66);
    expect(size("The Grand Imperial Tandoor Pavilion & Chai House")).toBeLessThan(66);
    expect(size("The Grand Imperial Tandoor Pavilion & Chai House")).toBeGreaterThanOrEqual(30);
  });
});
