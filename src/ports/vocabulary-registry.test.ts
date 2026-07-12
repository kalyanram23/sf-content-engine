import { describe, expect, it } from "vitest";

import type { ComponentVocabulary, VocabularyRegistry } from "./vocabulary-registry";

describe("VocabularyRegistry contract", () => {
  it("a map-backed registry satisfies the interface", () => {
    const vocab = {
      id: "noop",
      version: 1,
      registerNames: ["M"],
      defaultPhotoMode: "static",
      contentBox: (c) => ({ width: c.width, height: c.height }),
      minStreamWidth: 400,
      sectionGap: 12,
      landscapeBannerHeight: 200,
      photoBandCapacity: (bandWidth) => Math.max(1, Math.floor(bandWidth / 100)),
      metrics: () => ({
        sectionHeight: (n) => n * 20,
        groupHeight: (ns) => Math.max(...ns) * 20,
        photoBandHeight: () => 200,
        flowRowHeight: () => 20,
        flowLeadHeight: () => 50,
        cueHeight: () => 24,
        sectionInternalCols: (n, max) => (n <= 4 ? 1 : max),
      }),
      renderShell: ({ bodyHtml }) => `<div data-composed="noop@1">${bodyHtml}</div>`,
      renderSection: ({ section }) => `<div>${section.title}</div>`,
      renderGroup: ({ sections }) => `<div>${sections.length}</div>`,
      renderPhotoBand: () => `<div></div>`,
      renderFlowLead: ({ section }) => `<div>${section.title}</div>`,
      renderFlowRow: ({ item }) => `<div data-item-id="${item.id}"></div>`,
      renderContinuationCue: ({ sectionTitle }) => `<div>${sectionTitle} (cont.)</div>`,
      promptNotes: { section: "s", group: "g", photoBand: "p" },
    } satisfies ComponentVocabulary;
    const registry: VocabularyRegistry = new Map([[vocab.id, vocab]]);
    expect(registry.get("noop")?.id).toBe("noop");
    expect(registry.get("missing")).toBeUndefined();
  });
});
