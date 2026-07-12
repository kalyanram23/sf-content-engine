import { describe, expect, it } from "vitest";

import { dhabaVocabulary } from "./index";

const items = (n: number, withImages = false) =>
  Array.from({ length: n }, (_, i) => ({
    id: `i${i}`,
    name: `Dish ${i}`,
    price: i % 7 === 0 ? null : 9.99,
    hasImage: withImages,
  }));

describe("dhabaVocabulary", () => {
  it("declares the registry contract", () => {
    expect(dhabaVocabulary.id).toBe("dhaba");
    expect(dhabaVocabulary.registerNames).toEqual(["L", "M", "S"]);
    expect(dhabaVocabulary.defaultPhotoMode).toBe("filmstrip");
  });

  it("renderShell emits a single data-composed root, no document chrome, no hex colors", () => {
    const html = dhabaVocabulary.renderShell({
      title: "Street & Sweets",
      tagline: "Garma Garam!",
      canvas: { width: 1080, height: 1920 },
      register: "M",
      bodyHtml: "<div>BODY</div>",
    });
    expect(html).toMatch(/^<div[^>]*data-composed="dhaba@1"/);
    expect(html).not.toContain("<!DOCTYPE");
    expect(html).not.toContain("<link");
    expect(html).not.toContain(":root");
    expect(html).toContain("var(--color-accent)");
    expect(html).toContain("BODY");
  });

  it("renderSection stamps data-item-id on every row and renders MP for null prices", () => {
    const html = dhabaVocabulary.renderSection({
      number: 1,
      section: { title: "Biryani", items: items(6) },
      internalCols: 2,
      register: "M",
    });
    for (let i = 0; i < 6; i++) expect(html).toContain(`data-item-id="i${i}"`);
    expect(html).toContain(">MP<");
  });

  it("renderPhotoBand (filmstrip) emits src-less data-img-item placeholders and scoped keyframes", () => {
    const html = dhabaVocabulary.renderPhotoBand({
      items: items(4, true),
      register: "M",
      bandHeight: 300,
      bandWidth: 976,
      mode: "filmstrip",
      uid: "b1",
    });
    expect(html).toContain('data-img-item="i0"');
    expect(html).not.toMatch(/<img[^>]*\bsrc=/);
    expect(html).toContain("@keyframes slide_b1");
    expect(html).toContain("mask-image");
  });

  it("photo band carries the image-slot marker and a reduced-motion settled state (QA contract)", () => {
    for (const mode of ["filmstrip", "crossfade"] as const) {
      const html = dhabaVocabulary.renderPhotoBand({
        items: items(4, true),
        register: "M",
        bandHeight: 300,
        bandWidth: 976,
        mode,
        uid: "b1",
      });
      expect(html).toContain('data-image-slot="shared"');
      expect(html).toContain("prefers-reduced-motion");
    }
  });

  it("stamps a per-card data-image-slot when an item carries a slot (all three band modes)", () => {
    const slotted = [{ id: "s0", name: "Dosa", price: 9.99, hasImage: true, slot: "Dosa & Chaat" }];
    for (const mode of ["filmstrip", "crossfade", "static"] as const) {
      const html = dhabaVocabulary.renderPhotoBand({
        items: slotted,
        register: "M",
        bandHeight: 300,
        bandWidth: 976,
        mode,
        uid: "b1",
      });
      // The per-section marker escapes exactly like checkImageSlots' escapeSlotTitle (&amp;).
      expect(html).toContain('data-image-slot="Dosa &amp; Chaat"');
    }
  });

  it("stamps NO per-card slot marker when items carry none (only the band root's shared marker)", () => {
    const html = dhabaVocabulary.renderPhotoBand({
      items: items(3, true),
      register: "M",
      bandHeight: 300,
      bandWidth: 976,
      mode: "filmstrip",
      uid: "b1",
    });
    const slots = [...html.matchAll(/data-image-slot="([^"]*)"/g)].map((m) => m[1]);
    expect(slots).toEqual(["shared"]);
  });

  it('price rows carry data-bind="price" (binding-integrity contract)', () => {
    const html = dhabaVocabulary.renderSection({
      number: 1,
      section: { title: "Biryani", items: items(3) },
      internalCols: 1,
      register: "M",
    });
    expect(html).toContain('data-bind="price"');
  });

  it("metrics are monotone: more items → taller section; S register ≤ M ≤ L row heights", () => {
    const m = dhabaVocabulary.metrics("M");
    expect(m.sectionHeight(20, 2)).toBeGreaterThan(m.sectionHeight(6, 2));
    expect(dhabaVocabulary.metrics("S").flowRowHeight()).toBeLessThanOrEqual(
      dhabaVocabulary.metrics("M").flowRowHeight(),
    );
    expect(dhabaVocabulary.metrics("M").flowRowHeight()).toBeLessThanOrEqual(
      dhabaVocabulary.metrics("L").flowRowHeight(),
    );
  });
});
