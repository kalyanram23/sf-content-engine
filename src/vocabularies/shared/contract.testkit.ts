/**
 * Shared vocabulary toolbox — the ENGINE-CONTRACT TEST SUITE. `describeVocabularyContract(vocab)`
 * registers a vitest suite asserting every rule the engine/QA relies on, generalized from the
 * dhaba reference's test file. Each theme's test file calls this plus its own theme-specific
 * assertions, so a skill-generated vocabulary gets the full safety net for free.
 *
 * Test-only helper: imported exclusively from `*.test.ts` files (vitest is a dev dependency and
 * this file is never reachable from the library entries).
 */

import { describe, expect, it } from "vitest";

import type { ComponentVocabulary, VocabItem } from "../../ports/vocabulary-registry";
import { esc } from "./binding";

const PORTRAIT = { width: 1080, height: 1920 };
const LANDSCAPE = { width: 1920, height: 1080 };
/** Mirrors STACK_FILL in src/composition/layout.ts — the fitter's portrait fill target. */
const STACK_FILL = 0.92;
/** Mirrors COL_GAP in src/composition/layout.ts. */
const COL_GAP = 44;
/** Raw hex colours are banned in vocabulary output (tokens must be `var(--color-*)`;
 * alpha-composite `rgba()`/`color-mix()` inks with no token form are allowed). */
const HEX = /#[0-9a-fA-F]{3,8}\b/;

const items = (n: number, withImages = false): VocabItem[] =>
  Array.from({ length: n }, (_, i) => ({
    id: `i${i}`,
    name: `Dish ${i}`,
    price: i % 7 === 0 ? null : 9.99,
    hasImage: withImages,
  }));

const BAND_MODES = ["static", "crossfade", "filmstrip"] as const;

/** Register the engine-contract suite for one vocabulary. */
export function describeVocabularyContract(vocab: ComponentVocabulary): void {
  const smallest = vocab.registerNames[vocab.registerNames.length - 1]!;
  const largest = vocab.registerNames[0]!;
  const mid = vocab.registerNames[Math.floor(vocab.registerNames.length / 2)]!;

  const band = (mode: (typeof BAND_MODES)[number], list: VocabItem[]): string =>
    vocab.renderPhotoBand({
      items: list,
      register: mid,
      bandHeight: vocab.metrics(mid).photoBandHeight(),
      bandWidth: 976,
      mode,
      uid: "t1",
    });

  describe(`${vocab.id} vocabulary — engine contract`, () => {
    it("declares a sane registry contract", () => {
      expect(vocab.id.length).toBeGreaterThan(0);
      expect(vocab.version).toBeGreaterThanOrEqual(1);
      expect(vocab.registerNames.length).toBeGreaterThanOrEqual(2);
      expect(new Set(vocab.registerNames).size).toBe(vocab.registerNames.length);
      expect(vocab.minStreamWidth).toBeGreaterThan(0);
      expect(vocab.sectionGap).toBeGreaterThanOrEqual(0);
      expect(vocab.landscapeBannerHeight).toBeGreaterThan(0);
      for (const kind of ["section", "group", "photoBand"] as const) {
        expect(vocab.promptNotes[kind].length).toBeGreaterThan(0);
      }
    });

    it("renderShell: single data-composed root (id@version), no document chrome, token-pure", () => {
      const html = vocab.renderShell({
        title: "Street & Sweets",
        tagline: "Garma Garam!",
        canvas: PORTRAIT,
        register: mid,
        bodyHtml: "<div>BODY</div>",
      });
      expect(html).toMatch(new RegExp(`^<[a-z]+[^>]*data-composed="${vocab.id}@${vocab.version}"`));
      expect(html).not.toContain("<!DOCTYPE");
      expect(html).not.toContain("<link");
      expect(html).not.toContain("<script");
      expect(html).not.toContain(":root");
      expect(html).toContain("var(--color-");
      expect(html).toContain("BODY");
    });

    it("renderShell honours the brand-logo placeholder contract (D18)", () => {
      const html = vocab.renderShell({
        title: "Board",
        tagline: null,
        canvas: PORTRAIT,
        register: mid,
        bodyHtml: "",
        brand: { logo: { src: "ignored.png" }, name: "Tandoor & Tonic" },
      });
      expect(html).toContain("data-brand-logo");
      expect(html).not.toMatch(/<img[^>]*\bsrc=/);
    });

    it("emits NO raw hex colours anywhere (tokens via var(--color-*) only)", () => {
      const sec = { title: "Biryani", items: items(6) };
      const outputs = [
        vocab.renderShell({
          title: "T",
          tagline: "tag",
          canvas: PORTRAIT,
          register: mid,
          bodyHtml: "",
        }),
        vocab.renderSection({ number: 1, section: sec, internalCols: 2, register: mid }),
        vocab.renderGroup({
          startNumber: 1,
          sections: [sec, { title: "Chaat", items: items(3) }],
          register: mid,
        }),
        ...BAND_MODES.map((m) => band(m, items(4, true))),
        vocab.renderFlowLead({ number: 1, section: sec, register: mid }),
        vocab.renderFlowRow({ item: items(2)[1]!, register: mid }),
        vocab.renderContinuationCue({ sectionTitle: "Biryani", register: mid }),
      ];
      for (const html of outputs) expect(html).not.toMatch(HEX);
    });

    it("renderSection stamps data-item-id on every row; prices bound and filled (MP for null)", () => {
      const html = vocab.renderSection({
        number: 1,
        section: { title: "Biryani", items: items(6) },
        internalCols: 2,
        register: mid,
      });
      for (let i = 0; i < 6; i++) expect(html).toContain(`data-item-id="i${i}"`);
      // Every data-bind="price" element must have non-whitespace text (price-present contract) —
      // including the null-price item's market-price treatment.
      const binds = [...html.matchAll(/data-bind="price"[^>]*>([^<]*)</g)];
      expect(binds.length).toBeGreaterThanOrEqual(6);
      for (const m of binds) expect((m[1] ?? "").trim().length).toBeGreaterThan(0);
      expect(html).toContain("9.99");
      // Every row also carries the rename-overlay's data-bind="name" hook (§4, A4).
      const nameBinds = [...html.matchAll(/data-bind="name"[^>]*>([^<]*)</g)];
      expect(nameBinds.length).toBeGreaterThanOrEqual(6);
    });

    it("renders per-size tagged price spans for sized items (patcher contract, spec §4)", () => {
      const sized: VocabItem[] = [
        {
          id: "sz0",
          name: "Paneer Tikka",
          price: null,
          sizes: [
            { label: "Half", price: 6.5 },
            { label: "Full", price: 11 },
          ],
          hasImage: false,
        },
      ];
      const outputs = [
        vocab.renderSection({
          number: 1,
          section: { title: "Grill", items: sized },
          internalCols: 1,
          register: mid,
        }),
        vocab.renderFlowRow({ item: sized[0]!, register: mid }),
      ];
      for (const html of outputs) {
        expect(html).toContain('data-size="Half"');
        expect(html).toContain('data-size="Full"');
        expect(html).toContain("$6.50");
        expect(html).toContain("$11.00");
        // exactly one data-bind="price" span per size, none unlabelled
        const spans = [...html.matchAll(/data-bind="price"(?: data-size="([^"]*)")?/g)];
        expect(spans.every((m) => m[1] !== undefined)).toBe(true);
      }
    });

    it("renderGroup covers every member section's rows", () => {
      const a = { title: "Chaat", items: items(3) };
      const b = {
        title: "Rolls",
        items: [{ id: "r0", name: "Kathi", price: 7.5, hasImage: false }],
      };
      const html = vocab.renderGroup({ startNumber: 2, sections: [a, b], register: mid });
      for (const it_ of [...a.items, ...b.items]) {
        expect(html).toContain(`data-item-id="${it_.id}"`);
      }
      expect(html).toContain("Chaat");
      expect(html).toContain("Rolls");
    });

    it("photo bands: src-less placeholders, shared slot marker, settled carousel frames", () => {
      for (const mode of BAND_MODES) {
        const html = band(mode, items(4, true));
        expect(html).toContain('data-img-item="i0"');
        expect(html).not.toMatch(/<img[^>]*\bsrc=/);
        expect(html).toContain('data-image-slot="shared"');
        if (mode !== "static") {
          expect(html).toContain("prefers-reduced-motion");
          expect(html).toContain("t1"); // uid-scoped animation names
        }
      }
    });

    it("stamps per-card slot markers with QA-exact escaping (incl. quotes) in every band mode", () => {
      const slot = 'The "Big" & <Best> Board';
      const slotted: VocabItem[] = [
        { id: "s0", name: 'The "Combo"', price: 9.99, hasImage: true, slot },
      ];
      for (const mode of BAND_MODES) {
        const html = band(mode, slotted);
        expect(html).toContain(`data-image-slot="${esc(slot)}"`);
        expect(html).toContain(esc('The "Combo"'));
      }
    });

    it("stamps NO per-card slot when items carry none (only the shared band marker)", () => {
      const html = band("filmstrip", items(3, true));
      const slots = [...html.matchAll(/data-image-slot="([^"]*)"/g)].map((m) => m[1]);
      expect(slots).toEqual(["shared"]);
    });

    it("flow pieces: lead glues header+first row, rows bound, cue names the section", () => {
      const sec = { title: "Tandoor Mains", items: items(4) };
      const lead = vocab.renderFlowLead({ number: 3, section: sec, register: mid });
      expect(lead).toContain("Tandoor Mains");
      expect(lead).toContain('data-item-id="i0"');
      const row = vocab.renderFlowRow({ item: sec.items[1]!, register: mid });
      expect(row).toContain('data-item-id="i1"');
      expect(row).toContain('data-bind="price"');
      expect(row).toContain('data-bind="name"');
      const cue = vocab.renderContinuationCue({ sectionTitle: "Tandoor Mains", register: mid });
      expect(cue).toContain("Tandoor Mains");
    });

    it("metrics are positive, monotone in item count, and non-increasing across registers", () => {
      for (const name of vocab.registerNames) {
        const m = vocab.metrics(name);
        expect(m.sectionHeight(5, 1)).toBeGreaterThan(0);
        expect(m.sectionHeight(20, 2)).toBeGreaterThan(m.sectionHeight(6, 2));
        expect(m.groupHeight([5, 3])).toBeGreaterThanOrEqual(m.groupHeight([2, 1]));
        expect(m.photoBandHeight()).toBeGreaterThan(0);
        expect(m.flowLeadHeight()).toBeGreaterThan(m.flowRowHeight());
        expect(m.cueHeight()).toBeGreaterThan(0);
      }
      for (let i = 0; i + 1 < vocab.registerNames.length; i++) {
        const bigger = vocab.metrics(vocab.registerNames[i]!);
        const smaller = vocab.metrics(vocab.registerNames[i + 1]!);
        expect(smaller.flowRowHeight()).toBeLessThanOrEqual(bigger.flowRowHeight());
        expect(smaller.sectionHeight(10, 1)).toBeLessThanOrEqual(bigger.sectionHeight(10, 1));
      }
    });

    it("photoBandCapacity: at least 1, monotone in width", () => {
      expect(vocab.photoBandCapacity(10)).toBeGreaterThanOrEqual(1);
      expect(vocab.photoBandCapacity(1816)).toBeGreaterThanOrEqual(vocab.photoBandCapacity(976));
    });

    it("density: a 50-item section fits the portrait body at the smallest register (5–50 goal)", () => {
      const box = vocab.contentBox(PORTRAIT);
      expect(box.width).toBeGreaterThan(0);
      expect(box.width).toBeLessThan(PORTRAIT.width);
      expect(box.height).toBeLessThan(PORTRAIT.height);
      const m = vocab.metrics(smallest);
      // Stack mode allows up to 2 internal price columns (fit() passes maxInternalCols=2).
      const used = m.sectionHeight(50, m.sectionInternalCols(50, 2));
      expect(used).toBeLessThanOrEqual(box.height * STACK_FILL);
      // And a sparse board at the LARGEST register still fits comfortably.
      const sparse = vocab.metrics(largest).sectionHeight(5, 1);
      expect(sparse).toBeLessThan(box.height);
    });

    it("density: the landscape body affords at least 2 legible columns", () => {
      const box = vocab.contentBox(LANDSCAPE);
      const twoColWidth = Math.floor((box.width - COL_GAP) / 2);
      expect(twoColWidth).toBeGreaterThanOrEqual(vocab.minStreamWidth);
    });
  });
}
