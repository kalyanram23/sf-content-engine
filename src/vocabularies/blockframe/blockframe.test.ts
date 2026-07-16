import { describe, expect, it } from "vitest";

import { describeVocabularyContract } from "../shared/contract.testkit";
import { blockframeVocabulary } from "./index";

// The full engine contract (bindings, escaping, settled carousels, density, token purity).
describeVocabularyContract(blockframeVocabulary);

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
  blockframeVocabulary.renderShell({
    title: "Tandoor & Tonic",
    tagline: "Street kitchen",
    canvas: PORTRAIT,
    register: "M",
    bodyHtml: "",
  }),
  blockframeVocabulary.renderShell({
    title: "Tandoor & Tonic",
    tagline: null,
    canvas: LANDSCAPE,
    register: "M",
    bodyHtml: "",
  }),
  blockframeVocabulary.renderSection({
    number: 1,
    section: section(),
    internalCols: 1,
    register: "M",
  }),
  blockframeVocabulary.renderGroup({
    startNumber: 1,
    sections: [section(3), { title: "Coolers", items: items(2) }],
    register: "M",
  }),
  blockframeVocabulary.renderPhotoBand({
    items: items(3),
    register: "M",
    bandHeight: 280,
    bandWidth: 984,
    mode: "filmstrip",
    uid: "b1",
  }),
  blockframeVocabulary.renderFlowLead({ number: 2, section: section(), register: "M" }),
  blockframeVocabulary.renderFlowRow({ item: items(2)[1]!, register: "M" }),
  blockframeVocabulary.renderContinuationCue({ sectionTitle: "Small Plates", register: "M" }),
];

describe("blockframeVocabulary — theme specifics", () => {
  it("every shadow is a HARD offset: rem lengths + var() only — no blur, no rgba, no px", () => {
    let shadows = 0;
    for (const html of allOutputs()) {
      for (const m of html.matchAll(/box-shadow:([^;"]+)/g)) {
        shadows++;
        expect(m[1]).toMatch(/^\d*\.?\d+rem \d*\.?\d+rem 0 var\(--color-[a-z-]+\)$/);
      }
    }
    expect(shadows).toBeGreaterThan(0); // the depth system exists — cards actually cast shadows
  });

  it("framed blocks cast the signature 0.5rem ink shadow (section, group, photo card)", () => {
    const outputs = [
      blockframeVocabulary.renderSection({
        number: 1,
        section: section(),
        internalCols: 1,
        register: "M",
      }),
      blockframeVocabulary.renderGroup({
        startNumber: 1,
        sections: [section(3), { title: "Coolers", items: items(2) }],
        register: "M",
      }),
      blockframeVocabulary.renderPhotoBand({
        items: items(3),
        register: "M",
        bandHeight: 280,
        bandWidth: 984,
        mode: "static",
        uid: "b1",
      }),
    ];
    for (const html of outputs) {
      expect(html).toContain("box-shadow:0.5rem 0.5rem 0 var(--color-text)");
      expect(html).toContain("border:4px solid var(--color-text)");
    }
  });

  it("square corners everywhere: no border-radius in any rendered output", () => {
    for (const html of allOutputs()) expect(html).not.toContain("border-radius");
  });

  it("sections open with a candy-yellow Archivo Black band FLUSH at the card top", () => {
    const html = blockframeVocabulary.renderSection({
      number: 3,
      section: { title: "Tandoor Mains", items: items(4) },
      internalCols: 1,
      register: "L",
    });
    expect(html).toContain("background:var(--color-surface-strong)");
    expect(html).toContain("'Archivo Black',sans-serif");
    expect(html).toContain("text-transform:uppercase");
    expect(html).toContain("03"); // ink-bordered number chip, zero-padded
    // FLUSH: the band is the FIRST child inside the framed card — no padding above it.
    expect(html).toMatch(
      /border:4px solid var\(--color-text\);box-shadow:[^"]*"><div style="[^"]*background:var\(--color-surface-strong\)/,
    );
  });

  it("group members each get a small yellow band inside ONE shared framed card", () => {
    const html = blockframeVocabulary.renderGroup({
      startNumber: 4,
      sections: [section(3), { title: "Coolers", items: items(2) }],
      register: "M",
    });
    // one shared card frame…
    expect([...html.matchAll(/box-shadow:0\.5rem 0\.5rem 0 var\(--color-text\)/g)]).toHaveLength(1);
    // …divided by a 2px ink rule, with a yellow band per member
    expect(html).toContain("border-left:2px solid var(--color-text)");
    expect([...html.matchAll(/background:var\(--color-surface-strong\)/g)]).toHaveLength(2);
    expect(html).toContain("04");
    expect(html).toContain("05");
  });

  it("photo cards: ink-framed photo over a SOLID INK caption panel (paper text, uppercase)", () => {
    const html = blockframeVocabulary.renderPhotoBand({
      items: items(3),
      register: "M",
      bandHeight: 280,
      bandWidth: 984,
      mode: "static",
      uid: "b1",
    });
    expect(html).toContain("background:var(--color-text)"); // ink caption panel
    expect(html).toContain("color:var(--color-bg)"); // paper caption text
    expect(html).toContain("'Space Grotesk',sans-serif");
    expect(html).toContain("text-transform:uppercase");
    expect(html).not.toContain("rotate("); // hard-edged: no tilt anywhere
  });

  it("landscape shell wraps the body in ONE full-height framed card; portrait stays on paper", () => {
    const shell = (canvas: { width: number; height: number }): string =>
      blockframeVocabulary.renderShell({
        title: "Board",
        tagline: null,
        canvas,
        register: "M",
        bodyHtml: "<div>BODY</div>",
        brand: { logo: { src: "ignored.png" }, name: "Tandoor & Tonic" },
      });
    const landscape = shell(LANDSCAPE);
    expect(landscape).toMatch(
      /background:var\(--color-surface\);border:4px solid var\(--color-text\);box-shadow:0\.5rem 0\.5rem 0 var\(--color-text\);[^"]*"><div>BODY<\/div>/,
    );
    // Portrait: sections are already cards — the body sits directly on paper (no body card, and
    // with a real brand logo there is no shadow anywhere in the portrait shell).
    const portrait = shell(PORTRAIT);
    expect(portrait).not.toContain("border:4px solid var(--color-text)");
    expect(portrait).not.toContain("box-shadow");
    expect(portrait).toContain("<div>BODY</div>");
  });

  it("landscape contentBox subtracts the body card chrome and still affords 4 columns at 420px", () => {
    const box = blockframeVocabulary.contentBox(LANDSCAPE);
    // 1920 − 2×28 margins − 2×4 border − 2×20 card padding
    expect(box.width).toBe(1816);
    const fourColWidth = Math.floor((box.width - 3 * 44) / 4);
    expect(fourColWidth).toBeGreaterThanOrEqual(blockframeVocabulary.minStreamWidth);
  });

  it("margin marks are sparse geometric SVG in theme inks (pink cross present, no invented copy)", () => {
    const html = blockframeVocabulary.renderShell({
      title: "Board",
      tagline: null,
      canvas: PORTRAIT,
      register: "M",
      bodyHtml: "",
    });
    expect(html).toContain('fill="var(--color-accent)"'); // the one pink cross
    expect(html).toContain('stroke="var(--color-text)"'); // the ink zigzag
    expect([...html.matchAll(/width:26px;height:26px/g)]).toHaveLength(2); // two corner brackets
  });

  it("header shrinks long titles to one line in Archivo Black", () => {
    const size = (title: string): number =>
      Number(
        /font-family:'Archivo Black',sans-serif;font-size:(\d+)px/.exec(
          blockframeVocabulary.renderShell({
            title,
            tagline: null,
            canvas: PORTRAIT,
            register: "M",
            bodyHtml: "",
          }),
        )?.[1],
      );
    expect(size("Tiffin")).toBe(62);
    expect(size("The Grand Imperial Tandoor Pavilion & Chai House")).toBeLessThan(62);
    expect(size("The Grand Imperial Tandoor Pavilion & Chai House")).toBeGreaterThanOrEqual(30);
  });
});
