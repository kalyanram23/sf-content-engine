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

  it("warns when the distinct slots exceed the band capacity", async () => {
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
      photoMode: "static",
      composition: {
        title: "T",
        blocks: [{ kind: "photoBand", section: "", sections: [], itemIds: [] }],
      },
    });
    expect(res.warnings.join(" ")).toMatch(/image slots exceed/i);
  });
});

describe("renderComposed — photo band width capacity", () => {
  // Distinct photo-card ids in the band (filmstrip duplicates its cards for the seamless wrap, so a
  // Set collapses each card to one entry — the card COUNT).
  const imgIds = (html: string) =>
    new Set([...html.matchAll(/data-img-item="([^"]+)"/g)].map((m) => m[1]));
  const eightPhotos = Array.from({ length: 8 }, (_, i) => ({
    id: `ph${i}`,
    name: `Photo ${i}`,
    price: 9.99,
    hasImage: true,
  }));
  const bandComp: CompositionResponse = {
    title: "T",
    blocks: [
      { kind: "photoBand", section: "", sections: [], itemIds: eightPhotos.map((p) => p.id) },
    ],
  };

  it("caps a board-level band to what the PORTRAIT width accommodates (~3), not the mode's 12", async () => {
    // Portrait body ≈ 976px; dhaba caps at floor(976/262) = 3 curated cards (like gold-3b), though the
    // composer offered 8 — the fix for the frame-crop the live run showed.
    const res = await renderComposed({
      ...base,
      photoCandidates: eightPhotos,
      composition: bandComp,
    });
    expect(imgIds(res.html).size).toBe(3);
  });

  it("caps a LANDSCAPE banner to its wider width (~6)", async () => {
    // Landscape body ≈ 1816px; dhaba caps at floor(1816/262) = 6.
    const res = await renderComposed({
      ...base,
      canvas: { width: 1920, height: 1080 },
      photoCandidates: eightPhotos,
      composition: bandComp,
    });
    expect(imgIds(res.html).size).toBe(6);
  });

  it("never drops a photo slot for width: covers ALL distinct slots even past the cap, and warns", async () => {
    const sixSlots = Array.from({ length: 6 }, (_, i) => ({
      id: `s${i}`,
      name: `Dish ${i}`,
      price: 9.99,
      hasImage: true,
      slot: `Slot${i}`,
    }));
    const res = await renderComposed({
      ...base,
      sections: secs(Array.from({ length: 6 }, (_, i) => [`Slot${i}`, 2, true])),
      photoCandidates: sixSlots,
      composition: {
        title: "T",
        blocks: [{ kind: "photoBand", section: "", sections: [], itemIds: [] }],
      },
    });
    // Portrait width cap = 3, but slot coverage is a HARD guarantee (checkImageSlots needs a marker per
    // planned photo slot) → all 6 slots represented rather than a re-introduced image-slot-missing, plus a
    // warning surfacing the over-packing. Only FILLER is bound by the width cap.
    const slots = new Set([...res.html.matchAll(/data-image-slot="(Slot\d)"/g)].map((m) => m[1]));
    expect(slots.size).toBe(6);
    expect(res.warnings.join(" ")).toMatch(/image slots exceed the 3-card width capacity/);
  });

  it("bounds FILLER by the width cap: a per-section board adds no filler past its slot cards", async () => {
    // Two photo slots on a portrait board (width cap 3): the band shows the two guaranteed slot cards plus
    // at most one filler to reach the ≥3 floor — never the runaway pile the live run produced.
    const twoSlots = [
      { id: "s0", name: "A", price: 1, hasImage: true, slot: "Alpha" },
      { id: "s1", name: "B", price: 1, hasImage: true, slot: "Beta" },
      ...Array.from({ length: 6 }, (_, i) => ({
        id: `f${i}`,
        name: `Filler ${i}`,
        price: 1,
        hasImage: true,
        slot: "Alpha",
      })),
    ];
    const res = await renderComposed({
      ...base,
      sections: secs([
        ["Alpha", 4, true],
        ["Beta", 2, true],
      ]),
      photoCandidates: twoSlots,
      composition: {
        title: "T",
        blocks: [
          { kind: "photoBand", section: "", sections: [], itemIds: twoSlots.map((p) => p.id) },
        ],
      },
    });
    expect(imgIds(res.html).size).toBe(3); // 2 distinct slots + 1 filler to the ≥3 floor, capped at 3
  });
});

describe("renderComposed — landscape measured-overflow guard (re-fit vs measured pixels)", () => {
  // A controllable vocabulary whose flow pieces are TAGGED with their register (`data-reg`) so a fake
  // `measure` can return DIFFERENT per-row heights per register — the only way to exercise a register
  // demotion at the layout/renderer seam. `contentBox` fixes the body at 600px (no banner → avail=600)
  // and `minStreamWidth`/canvas force maxColumns=2, so ADDING a column is unavailable → the guard's
  // only lever is demotion, which is the live landscape board's situation (already at maxColumns).
  // The ESTIMATE metrics (what `fit` reads) deliberately UNDER-shoot the measured heights: `fit` picks
  // BIG on estimate, but the real measured tallest column overflows — exactly the estimate-vs-measured
  // gap the guard closes.
  const flowVocab = (): ComponentVocabulary => ({
    id: "flow",
    version: 1,
    registerNames: ["BIG", "SMALL"],
    defaultPhotoMode: "static",
    minStreamWidth: 700,
    sectionGap: 0,
    landscapeBannerHeight: 0,
    photoBandCapacity: () => 5,
    contentBox: (c) => ({ width: c.width - 100, height: 600 }),
    metrics: (register) => {
      const row = register === "BIG" ? 20 : 8; // ESTIMATE only — measure returns the real (bigger) px
      return {
        sectionHeight: (n: number, cols: number) => 40 + Math.ceil(n / Math.max(1, cols)) * row,
        groupHeight: (ns: number[]) => 40 + Math.max(1, ...ns) * row,
        photoBandHeight: () => 0,
        flowRowHeight: () => row,
        flowLeadHeight: () => 40 + row,
        cueHeight: () => (register === "BIG" ? 20 : 10),
        sectionInternalCols: () => 1,
      };
    },
    renderShell: ({ bodyHtml }) => `<div data-composed="flow@1">${bodyHtml}</div>`,
    renderSection: () => "<div></div>",
    renderGroup: () => "<div></div>",
    renderPhotoBand: () => "<div></div>",
    renderFlowLead: ({ register, number, section }) =>
      `<span data-reg="${register}">L${number} ${section.title}</span>`,
    renderFlowRow: ({ register, item }) =>
      `<span data-reg="${register}" data-item-id="${item.id}">${item.name}</span>`,
    renderContinuationCue: ({ register, sectionTitle }) =>
      `<span data-reg="${register}">${sectionTitle} (cont.)</span>`,
    promptNotes: { section: "", group: "", photoBand: "" },
  });

  const flowSecs = (specs: Array<[string, number]>) =>
    specs.map(([title, n]) => ({
      title,
      items: Array.from({ length: n }, (_, i) => ({
        id: `${title}-${i}`,
        name: `${title} ${i}`,
        price: 1,
        hasImage: false,
      })),
    }));

  /** A fake `measure` returning per-register heights, keyed off the `data-reg` the flow pieces carry. */
  const regMeasure = (per: Record<string, number>, cue = 6) => {
    const calls: string[] = [];
    const fn = async ({ html }: { html: string }): Promise<Record<string, number>> => {
      const reg = html.match(/data-reg="([^"]+)"/)?.[1] ?? "BIG";
      calls.push(reg);
      const keys = [...html.matchAll(/data-mk="([^"]+)"/g)].map((m) => m[1]!);
      return Object.fromEntries(keys.map((k) => [k, k === "__cue__" ? cue : (per[reg] ?? 0)]));
    };
    return { fn, calls };
  };

  const landscapeInput = (
    specs: Array<[string, number]>,
    measure: (req: { html: string }) => Promise<Record<string, number>>,
  ) => {
    const sections = flowSecs(specs);
    return {
      ...base,
      vocab: flowVocab(),
      canvas: { width: 1920, height: 1080 },
      sections,
      photoCandidates: [],
      measure,
      composition: {
        title: "T",
        blocks: sections.map((s) => ({
          kind: "section" as const,
          section: s.title,
          sections: [],
          itemIds: [],
        })),
      },
    };
  };

  it("demotes the register when the MEASURED tallest column overflows the body (estimate passed)", async () => {
    // fit picks BIG on estimate; at BIG each unit measures 110px → each of two 6-unit columns is 660px >
    // avail 600 → overflow. The guard re-measures at SMALL (40px/unit → 240px columns) and ships that.
    const { fn, calls } = regMeasure({ BIG: 110, SMALL: 40 });
    const res = await renderComposed(
      landscapeInput(
        [
          ["Aaa", 6],
          ["Bbb", 6],
        ],
        fn,
      ),
    );
    expect(calls).toEqual(["BIG", "SMALL"]); // measured BIG first, demoted to SMALL
    expect(res.columnPlan?.register).toBe("SMALL");
    expect(res.columnPlan?.overflow).toBe(false); // the shipped board clears the body
    expect(res.html).toContain('data-reg="SMALL"'); // rows rendered at the demoted register
    expect(res.html).not.toContain('data-reg="BIG"');
  });

  it("demotes on the BOTTOM-SAFETY margin — measured tallest is UNDER the body but within the safety", async () => {
    // At BIG each 3-unit column measures 597px — BELOW avail 600, so a bare `tallest > avail` guard would
    // NOT fire, yet its last row would kiss the bottom frame. The COLUMNS_BOTTOM_SAFETY (8px) margin
    // treats 597 > (600 − 8 = 592) as overflow and demotes to SMALL (300px columns). Removing the safety
    // margin regresses this test (BIG would ship), pinning the margin as load-bearing.
    const { fn, calls } = regMeasure({ BIG: 199, SMALL: 100 });
    const res = await renderComposed(
      landscapeInput(
        [
          ["Aaa", 3],
          ["Bbb", 3],
        ],
        fn,
      ),
    );
    expect(calls).toEqual(["BIG", "SMALL"]);
    expect(res.columnPlan?.register).toBe("SMALL");
    expect(res.html).toContain('data-reg="SMALL"');
  });

  it("inlines the theme @font-face into the MEASURE document (offline wrapping matches the poster)", async () => {
    // The primary fix: the measure doc carries the theme's real faces (offline data: URIs), so the
    // offline measure wraps headers/rows exactly as the poster — the measured partition matches the
    // render instead of mis-measuring a system-font fallback.
    let doc = "";
    const measure = async ({ html }: { html: string }): Promise<Record<string, number>> => {
      doc = html;
      const keys = [...html.matchAll(/data-mk="([^"]+)"/g)].map((m) => m[1]!);
      return Object.fromEntries(keys.map((k) => [k, k === "__cue__" ? 6 : 20]));
    };
    await renderComposed({
      ...landscapeInput(
        [
          ["Aaa", 3],
          ["Bbb", 3],
        ],
        measure,
      ),
      // A real body stack already carries quotes + fallbacks (as theme tokens do).
      fontFamilies: {
        display: "'Shrikhand', Georgia, serif",
        body: "'Archivo', system-ui, sans-serif",
      },
      fontFaces: [{ family: "Shrikhand", dataUri: "data:font/woff2;base64,AAAA" }],
    });
    expect(doc).toContain("@font-face");
    expect(doc).toContain("font-family:'Shrikhand'");
    expect(doc).toContain("data:font/woff2;base64,AAAA");
    // The rows' font-family = the theme body stack VERBATIM (rows inherit it). Re-quoting the whole
    // stack (the offline-measure clip bug) yields malformed `''Archivo', …'` and drops rows to a system
    // fallback → every row mis-measured. Pin the well-formed stack and the absence of the double-quote.
    expect(doc).toContain("font-family:'Archivo', system-ui, sans-serif");
    expect(doc).not.toContain("''Archivo'");
    // The continuation-cue sample is measured inside a BFC (flow-root) so its own bottom margin is
    // included — otherwise a continuation column is under-measured by the cue margin and can clip.
    expect(doc).toContain('data-mk="__cue__" style="display:flow-root"');
    // The measure renders at the packaged base line-height (Tailwind preflight's 1.5), which every row
    // inherits — without it rows measure at the UA `normal` and a full column is under-measured ~100px.
    expect(doc).toContain("line-height:1.5");
  });

  it("does NOT demote (single measure) when the board fits with headroom — no over-shrink", async () => {
    // A comfortable board: 4 small units at BIG measure 30px → 60px columns + drift well under 600. The
    // guard measures ONCE and keeps BIG — the common passing-board path is untouched (no extra measures,
    // no needless type reduction that would under-fill a board that already fit).
    const { fn, calls } = regMeasure({ BIG: 30, SMALL: 12 });
    const res = await renderComposed(
      landscapeInput(
        [
          ["Aaa", 2],
          ["Bbb", 2],
        ],
        fn,
      ),
    );
    expect(calls).toEqual(["BIG"]); // exactly one measure — no re-fit
    expect(res.columnPlan?.register).toBe("BIG");
    expect(res.columnPlan?.overflow).toBe(false);
    expect(res.html).toContain('data-reg="BIG"');
  });
});

describe("renderComposed — sparse-board photo growth (both orientations)", () => {
  const sparseComp: CompositionResponse = {
    title: "Street & Sweets",
    blocks: [
      { kind: "section", section: "Chaat", sections: [], itemIds: [] },
      { kind: "photoBand", section: "", sections: [], itemIds: ["Chaat-0", "Chaat-1"] },
    ],
  };
  const sparse = {
    ...base,
    sections: secs([["Chaat", 3, true]]),
    photoCandidates: secs([["Chaat", 3, true]])[0]!.items,
  };
  const bandHeightIn = (html: string): number =>
    Number(/data-image-slot="shared" style="height:([\d.]+)px/.exec(html)?.[1]);
  const baseBandH = dhabaVocabulary.metrics("L").photoBandHeight();

  it("portrait: a sparse board's band grows above its base height, capped at 1.8×", async () => {
    const res = await renderComposed({ ...sparse, composition: sparseComp });
    const h = bandHeightIn(res.html);
    expect(h).toBeGreaterThan(baseBandH);
    expect(h).toBeLessThanOrEqual(Math.ceil(baseBandH * 1.8));
  });

  it("portrait: a packed board's band does NOT grow", async () => {
    const packed = {
      ...base,
      sections: secs([
        ["Dosa", 60, true],
        ["Desserts", 40],
        ["Chaat", 30],
      ]),
      photoCandidates: secs([["Dosa", 20, true]])[0]!.items,
    };
    const res = await renderComposed({
      ...packed,
      composition: {
        title: "Street & Sweets",
        blocks: [
          { kind: "section", section: "Dosa", sections: [], itemIds: [] },
          { kind: "photoBand", section: "", sections: [], itemIds: ["Dosa-0"] },
        ],
      },
    });
    const h = bandHeightIn(res.html);
    const fitted = dhabaVocabulary.metrics(res.fit.register).photoBandHeight();
    expect(h).toBe(fitted);
  });

  it("landscape: a sparse board's banner grows and the measured guard sees the reduced space", async () => {
    const res = await renderComposed({
      ...sparse,
      canvas: { width: 1920, height: 1080 },
      composition: sparseComp,
      measure: async ({ html }) => {
        const keys = [...html.matchAll(/data-mk="([^"]+)"/g)].map((m) => m[1]!);
        return Object.fromEntries(keys.map((k) => [k, k === "__cue__" ? 24 : 30]));
      },
    });
    const h = bandHeightIn(res.html);
    expect(h).toBeGreaterThan(dhabaVocabulary.landscapeBannerHeight);
    expect(h).toBeLessThanOrEqual(Math.ceil(dhabaVocabulary.landscapeBannerHeight * 1.8));
    expect(res.columnPlan?.overflow).toBe(false);
    // avail shrank by exactly the banner growth: avail + growth + base banner + gap = body height
    const growth = h - dhabaVocabulary.landscapeBannerHeight;
    const box = dhabaVocabulary.contentBox({ width: 1920, height: 1080 });
    expect(res.columnPlan!.avail).toBe(
      Math.round(box.height - dhabaVocabulary.landscapeBannerHeight - 24 - growth),
    );
  });
});
