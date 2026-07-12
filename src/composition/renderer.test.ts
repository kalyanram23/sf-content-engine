import { describe, expect, it } from "vitest";

import type { CompositionResponse } from "../domain/contracts";
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
