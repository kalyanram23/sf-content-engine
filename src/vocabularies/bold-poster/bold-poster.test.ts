import { describe, expect, it } from "vitest";

import { describeVocabularyContract } from "../shared/contract.testkit";
import { boldPosterVocabulary } from "./index";

// The full engine contract (bindings, escaping, settled carousels, density, token purity).
describeVocabularyContract(boldPosterVocabulary);

const items = (n: number) =>
  Array.from({ length: n }, (_, i) => ({
    id: `i${i}`,
    name: `Dish ${i}`,
    price: 9.99,
    hasImage: true,
  }));

describe("boldPosterVocabulary — theme specifics", () => {
  it("is FLAT like print: no shadows anywhere (identity: depth from scale and rules only)", () => {
    const outputs = [
      boldPosterVocabulary.renderShell({
        title: "Tandoor & Tonic",
        tagline: "Street kitchen",
        canvas: { width: 1080, height: 1920 },
        register: "M",
        bodyHtml: "",
      }),
      boldPosterVocabulary.renderSection({
        number: 1,
        section: { title: "Small Plates", items: items(5) },
        internalCols: 1,
        register: "M",
      }),
      boldPosterVocabulary.renderPhotoBand({
        items: items(3),
        register: "M",
        bandHeight: 280,
        bandWidth: 984,
        mode: "filmstrip",
        uid: "b1",
      }),
    ];
    for (const html of outputs) expect(html).not.toContain("box-shadow");
  });

  it("sections open with the red editorial kicker over a Shrikhand headline", () => {
    const html = boldPosterVocabulary.renderSection({
      number: 3,
      section: { title: "Tandoor Mains", items: items(4) },
      internalCols: 1,
      register: "L",
    });
    expect(html).toContain("NO. 03");
    expect(html).toContain("letter-spacing:4px");
    expect(html).toContain("'Shrikhand',serif");
    expect(html).toContain("Tandoor Mains");
  });

  it("masthead carries the double editorial rules, crop marks frame the page", () => {
    const html = boldPosterVocabulary.renderShell({
      title: "Tandoor & Tonic",
      tagline: null,
      canvas: { width: 1080, height: 1920 },
      register: "M",
      bodyHtml: "",
    });
    expect(html).toContain("border-top:6px solid var(--color-text)");
    expect(html).toContain("border-bottom:6px solid var(--color-text)");
    // four corner crop marks
    expect([...html.matchAll(/width:26px;height:26px/g)]).toHaveLength(4);
  });

  it("masthead shrinks long titles to one line and only tilts the title (≤2°)", () => {
    const short = boldPosterVocabulary.renderShell({
      title: "Tiffin",
      tagline: null,
      canvas: { width: 1080, height: 1920 },
      register: "M",
      bodyHtml: "",
    });
    const long = boldPosterVocabulary.renderShell({
      title: "The Grand Imperial Tandoor Pavilion & Chai House",
      tagline: null,
      canvas: { width: 1080, height: 1920 },
      register: "M",
      bodyHtml: "",
    });
    const size = (html: string): number =>
      Number(/font-family:'Shrikhand',serif;font-size:(\d+)px/.exec(html)?.[1]);
    expect(size(short)).toBe(84);
    expect(size(long)).toBeLessThan(size(short));
    expect(size(long)).toBeGreaterThanOrEqual(40);
    expect(long).toContain("rotate(-1.5deg)");
  });

  it("cover shots: ink-ruled photo frame on a tan panel with a paper caption", () => {
    const html = boldPosterVocabulary.renderPhotoBand({
      items: items(3),
      register: "M",
      bandHeight: 280,
      bandWidth: 984,
      mode: "static",
      uid: "b1",
    });
    expect(html).toContain("background:var(--color-surface-strong)"); // tan panel
    expect(html).toContain("border:2px solid var(--color-text)"); // thin ink frame
    expect(html).toContain("background:var(--color-surface)"); // paper caption band
    expect(html).not.toContain("rotate("); // flat: offsets, never tilt
  });

  it("landscape masthead is compact (120px) vs the editorial portrait masthead (200px)", () => {
    const portrait = boldPosterVocabulary.contentBox({ width: 1080, height: 1920 });
    const landscape = boldPosterVocabulary.contentBox({ width: 1920, height: 1080 });
    expect(1920 - portrait.height).toBe(200 + 28 + 40);
    expect(1080 - landscape.height).toBe(120 + 28 + 40);
  });
});
