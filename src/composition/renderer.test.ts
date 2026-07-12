import { describe, expect, it } from "vitest";

import type { CompositionResponse } from "../domain/contracts";
import type { ComponentVocabulary } from "../ports/vocabulary-registry";
import { dhabaVocabulary } from "../vocabularies/dhaba/index";
import { renderComposed } from "./renderer";

const secs = (spec: Array<[string, number, boolean?]>) =>
  spec.map(([title, n, img]) => ({
    title,
    items: Array.from({ length: n }, (_, i) => ({
      id: `${title}-${i}`,
      name: `${title} dish ${i}`,
      price: 9.99,
      hasImage: Boolean(img),
    })),
  }));

const base = {
  sections: secs([
    ["Dosa", 7, true],
    ["Desserts", 15],
    ["Chaat", 2],
    ["Hot Drinks", 4],
  ]),
  photoCandidates: secs([["Dosa", 7, true]])[0]!.items,
  canvas: { width: 1080, height: 1920 },
  tagline: "Garma Garam!",
  vocab: dhabaVocabulary,
  photoMode: "filmstrip" as const,
  colorTokens: {
    bg: "#f8ecd4",
    text: "#2a1a0e",
    accent: "#c22415",
    price: "#c22415",
    chip: "#0d6e5c",
    surface: "#ffffff",
    muted: "#57503f",
    stripe: "#f2b53a",
  },
  fontFamilies: { display: "Shrikhand", body: "Archivo" },
};

const comp: CompositionResponse = {
  title: "Street & Sweets",
  blocks: [
    { kind: "section", section: "Dosa", sections: [], itemIds: [] },
    { kind: "photoBand", section: "", sections: [], itemIds: ["Dosa-0", "Dosa-1", "Dosa-2"] },
    { kind: "group", section: "", sections: ["Chaat", "Hot Drinks"], itemIds: [] },
  ],
};

describe("renderComposed", () => {
  it("guarantees coverage: appends sections the composition forgot (Desserts)", async () => {
    const res = await renderComposed({ ...base, composition: comp });
    expect(res.warnings.join(" ")).toContain("Desserts");
    expect(res.html).toContain('data-item-id="Desserts-0"');
    // every item of every section is bound exactly once
    for (const s of base.sections)
      for (const it of s.items) expect(res.html).toContain(`data-item-id="${it.id}"`);
  });

  it("emits a single token-declaring composed root and no external chrome", async () => {
    const res = await renderComposed({ ...base, composition: comp });
    expect(res.html).toMatch(/^<div[^>]*data-composed=/);
    expect(res.html).toContain("--color-accent:#c22415");
    expect(res.html).not.toContain("<link");
    expect(res.html).not.toMatch(/<img[^>]*\bsrc=/);
  });

  it("landscape: partitions into measured columns and stamps continuation cues", async () => {
    const measured: string[] = [];
    const res = await renderComposed({
      ...base,
      canvas: { width: 1920, height: 1080 },
      composition: comp,
      measure: async ({ html }) => {
        measured.push(html);
        const keys = [...html.matchAll(/data-mk="([^"]+)"/g)].map((m) => m[1]!);
        return Object.fromEntries(keys.map((k) => [k, k === "__cue__" ? 24 : 30]));
      },
    });
    expect(measured).toHaveLength(1);
    expect(res.columnPlan?.columns).toBeGreaterThanOrEqual(2);
    // 28 flow rows at 30px across ≥2 columns must split at least one section → ≥1 cue
    expect(res.columnPlan?.cues.length).toBeGreaterThanOrEqual(1);
    expect(res.html).toContain("(cont.)");
  });

  it("stays theme-agnostic: renderer emits no theme inset literal — the shell owns the body padding", async () => {
    // Spy the vocabulary shell to capture exactly the body markup the RENDERER hands it: that markup
    // is composition-layer-owned and must carry no theme inset (dhaba's 24/36/30 padding is applied
    // inside renderShell, one layer deeper). Cover all three body paths: portrait stack, landscape
    // CSS-balance columns (no measurer), and landscape measured columns (measurer supplied).
    const measure = async ({ html }: { html: string }): Promise<Record<string, number>> => {
      const keys = [...html.matchAll(/data-mk="([^"]+)"/g)].map((m) => m[1]!);
      return Object.fromEntries(keys.map((k) => [k, k === "__cue__" ? 24 : 30]));
    };
    const paths = [
      { canvas: { width: 1080, height: 1920 } }, // portrait stack
      { canvas: { width: 1920, height: 1080 } }, // landscape CSS-balance columns
      { canvas: { width: 1920, height: 1080 }, measure }, // landscape measured columns
    ];
    for (const path of paths) {
      let capturedBody = "";
      const spyVocab: ComponentVocabulary = {
        ...dhabaVocabulary,
        renderShell: (args) => {
          capturedBody = args.bodyHtml;
          return dhabaVocabulary.renderShell(args);
        },
      };
      const res = await renderComposed({ ...base, ...path, vocab: spyVocab, composition: comp });
      expect(capturedBody).not.toContain("24px 36px 30px");

      // The data-composed root the renderer builds around the shell declares ONLY colour tokens.
      const wrapperTag = res.html.match(/^<div[^>]*>/)![0];
      expect(wrapperTag).not.toContain("padding");
      const style = wrapperTag.match(/style="([^"]*)"/)![1]!;
      for (const decl of style.split(";").filter(Boolean))
        expect(decl.startsWith("--color-")).toBe(true);
    }
  });

  it("drops a group with <2 known sections to plain sections with a warning", async () => {
    const res = await renderComposed({
      ...base,
      composition: {
        title: "X",
        blocks: [{ kind: "group", section: "", sections: ["Chaat", "Nope"], itemIds: [] }],
      },
    });
    expect(res.warnings.join(" ")).toContain("group");
  });
});

describe("renderComposed — per-section slot coverage guarantee", () => {
  const slottedCandidates = [
    { id: "p-a", name: "Alpha dish", price: 9.99, hasImage: true, slot: "Alpha" },
    { id: "p-b", name: "Beta dish", price: 9.99, hasImage: true, slot: "Beta" },
    { id: "p-c", name: "Gamma dish", price: 9.99, hasImage: true, slot: "Gamma" },
  ];
  const slotBase = {
    ...base,
    sections: secs([
      ["Alpha", 3, true],
      ["Beta", 3, true],
      ["Gamma", 3, true],
    ]),
    photoCandidates: slottedCandidates,
  };

  it("represents a slot the composer's photoBand picks IGNORED with ≥1 card", async () => {
    // The composer picks only Alpha's photo; the coverage guarantee still yields a card for Beta + Gamma.
    const res = await renderComposed({
      ...slotBase,
      composition: {
        title: "T",
        blocks: [
          { kind: "photoBand", section: "", sections: [], itemIds: ["p-a"] },
          { kind: "section", section: "Alpha", sections: [], itemIds: [] },
          { kind: "section", section: "Beta", sections: [], itemIds: [] },
          { kind: "section", section: "Gamma", sections: [], itemIds: [] },
        ],
      },
    });
    expect(res.html).toContain('data-image-slot="Alpha"');
    expect(res.html).toContain('data-image-slot="Beta"');
    expect(res.html).toContain('data-image-slot="Gamma"');
  });

  it("appends a photoBand when the composer emitted none but per-section slots exist", async () => {
    const res = await renderComposed({
      ...slotBase,
      composition: { title: "T", blocks: [] }, // composer forgot the band entirely
    });
    for (const slot of ["Alpha", "Beta", "Gamma"])
      expect(res.html).toContain(`data-image-slot="${slot}"`);
  });

  it("warns when the distinct slots exceed the band capacity (static ≤5)", async () => {
    const many = Array.from({ length: 6 }, (_, i) => ({
      id: `p${i}`,
      name: `Dish ${i}`,
      price: 9.99,
      hasImage: true,
      slot: `Slot${i}`,
    }));
    const res = await renderComposed({
      ...base,
      sections: secs(Array.from({ length: 6 }, (_, i) => [`Slot${i}`, 2, true])),
      photoCandidates: many,
      photoMode: "static", // max 5 cards
      composition: {
        title: "T",
        blocks: [{ kind: "photoBand", section: "", sections: [], itemIds: [] }],
      },
    });
    expect(res.warnings.join(" ")).toMatch(/image slots exceed/i);
  });
});
