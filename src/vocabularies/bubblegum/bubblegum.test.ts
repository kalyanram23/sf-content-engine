import { describe, expect, it } from "vitest";

import { describeVocabularyContract } from "../shared/contract.testkit";
import { bubblegumVocabulary } from "./index";

// The full engine contract (bindings, escaping, settled carousels, density, token purity).
describeVocabularyContract(bubblegumVocabulary);

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
  bubblegumVocabulary.renderShell({
    title: "Tandoor & Tonic",
    tagline: "Street kitchen",
    canvas: PORTRAIT,
    register: "M",
    bodyHtml: "",
  }),
  bubblegumVocabulary.renderShell({
    title: "Tandoor & Tonic",
    tagline: null,
    canvas: LANDSCAPE,
    register: "M",
    bodyHtml: "",
  }),
  bubblegumVocabulary.renderSection({
    number: 1,
    section: section(),
    internalCols: 1,
    register: "M",
  }),
  bubblegumVocabulary.renderGroup({
    startNumber: 1,
    sections: [section(3), { title: "Coolers", items: items(2) }],
    register: "M",
  }),
  ...(["static", "crossfade", "filmstrip"] as const).map((mode) =>
    bubblegumVocabulary.renderPhotoBand({
      items: items(3),
      register: "M",
      bandHeight: 260,
      bandWidth: 992,
      mode,
      uid: "b1",
    }),
  ),
  bubblegumVocabulary.renderFlowLead({ number: 2, section: section(), register: "M" }),
  bubblegumVocabulary.renderFlowRow({ item: items(2)[1]!, register: "M" }),
  bubblegumVocabulary.renderContinuationCue({ sectionTitle: "Small Plates", register: "M" }),
];

describe("bubblegumVocabulary — theme specifics", () => {
  it("defaults its photo bands to CROSSFADE (the identity's photo carousel)", () => {
    expect(bubblegumVocabulary.defaultPhotoMode).toBe("crossfade");
  });

  it("section pill backing rotates by section number: 1 → coral, 2 → mint, 0 → sunny yellow", () => {
    const expected = ["accent", "accent-strong", "price"]; // n = 1, 2, 3(≡0), then wraps
    for (const n of [1, 2, 3, 4, 5, 6]) {
      const html = bubblegumVocabulary.renderSection({
        number: n,
        section: section(),
        internalCols: 1,
        register: "M",
      });
      const m = /background:var\(--color-([a-z-]+)\);border-radius:999px/.exec(html);
      expect(m?.[1]).toBe(expected[(n - 1) % 3]);
      // The pill carries DARK Anton all-caps text + a small dark rounded number chip inside it.
      expect(html).toContain("color:var(--color-bg)");
      expect(html).toContain("'Anton',sans-serif");
      expect(html).toMatch(
        /background:var\(--color-bg\);color:var\(--color-text\);border-radius:999px/,
      );
      expect(html).toContain(`>${String(n).padStart(2, "0")}<`);
    }
  });

  it("NO border-radius below 12px anywhere — everything reads soft and rounded", () => {
    let radii = 0;
    for (const html of allOutputs()) {
      for (const m of html.matchAll(/border-radius:([^;"]+)/g)) {
        for (const part of m[1]!.trim().split(/\s+/)) {
          radii++;
          const px = /^([\d.]+)px$/.exec(part);
          expect(px, `unexpected radius unit: ${part}`).not.toBeNull();
          expect(Number(px![1])).toBeGreaterThanOrEqual(12);
        }
      }
    }
    expect(radii).toBeGreaterThan(0); // the rounded system exists
  });

  it("film-grain overlay: inline fractalNoise SVG over the whole canvas at opacity ≤ 0.04", () => {
    for (const canvas of [PORTRAIT, LANDSCAPE]) {
      const html = bubblegumVocabulary.renderShell({
        title: "Board",
        tagline: null,
        canvas,
        register: "M",
        bodyHtml: "",
      });
      expect(html).toContain("fractalNoise");
      const m = /<svg[^>]*inset:0[^>]*opacity:([\d.]+)/.exec(html);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBeLessThanOrEqual(0.04);
      expect(Number(m![1])).toBeGreaterThan(0);
    }
  });

  it("emits NO thin solid rules (1–2px) anywhere — dotted leaders are the only fine lines", () => {
    for (const html of allOutputs()) {
      expect(html).not.toMatch(/border[^:;"]*:\s*[12]px solid/);
    }
  });

  it("emits no rgba() literal anywhere (translucency is color-mix over tokens)", () => {
    for (const html of allOutputs()) expect(html).not.toContain("rgba(");
  });

  it("section cards are borderless rounded stickers (28px) with a glossy top sheen", () => {
    const html = bubblegumVocabulary.renderSection({
      number: 1,
      section: section(),
      internalCols: 1,
      register: "M",
    });
    expect(html).toContain("background:var(--color-surface);border-radius:28px");
    expect(html).not.toMatch(/border:\d+px solid/); // no ink frames in this theme
    expect(html).toContain(
      "linear-gradient(to bottom,color-mix(in srgb,var(--color-text) 6%,transparent),transparent)",
    );
  });

  it("rows: Inter near-white names, dotted lavender leader, bold sunny-yellow tabular price; null price → rounded MP pill", () => {
    const html = bubblegumVocabulary.renderSection({
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
    expect(html).toContain("'Inter',sans-serif");
    expect(html).toContain(
      "border-bottom:2px dotted color-mix(in srgb,var(--color-muted) 55%,transparent)",
    );
    const prices = [...html.matchAll(/data-bind="price" style="([^"]*)">([^<]*)</g)];
    expect(prices).toHaveLength(2);
    expect(prices[0]![1]).toContain("color:var(--color-price)");
    expect(prices[0]![1]).toContain("font-variant-numeric:tabular-nums");
    expect(prices[0]![2]).toBe("$12.50");
    // The market-price pill: fully rounded, lifted-grape backing, yellow MP.
    expect(prices[1]![1]).toContain("background:var(--color-surface-strong)");
    expect(prices[1]![1]).toContain("border-radius:999px");
    expect(prices[1]![1]).toContain("color:var(--color-price)");
    expect(prices[1]![2]).toBe("MP");
  });

  it("groups: 2–3 small sections inside ONE sticker card, divided by CHUNKY 6px rounded bars", () => {
    const html = bubblegumVocabulary.renderGroup({
      startNumber: 4,
      sections: [section(3), { title: "Coolers", items: items(2) }],
      register: "M",
    });
    // ONE shared sticker card…
    expect([...html.matchAll(/border-radius:28px/g)]).toHaveLength(1);
    // …divided by a chunky fully-rounded bar (never a thin hairline)
    expect(html).toContain("width:6px;border-radius:999px;background:var(--color-surface-strong)");
    expect(html).not.toMatch(/border-left/);
    // member pills keep numbering + rotation (04 → coral, 05 → mint)
    expect(html).toContain(">04<");
    expect(html).toContain(">05<");
    expect(html).toContain("background:var(--color-accent);border-radius:999px");
    expect(html).toContain("background:var(--color-accent-strong);border-radius:999px");
  });

  it("photo cards: rounded-20px stickers with a thick 6px near-white border, ±2deg alternating tilt, ~4:3 aspect", () => {
    for (const bandHeight of [240, 300, 420]) {
      const html = bubblegumVocabulary.renderPhotoBand({
        items: items(2),
        register: "M",
        bandHeight,
        bandWidth: 992,
        mode: "static",
        uid: "b1",
      });
      expect(html).toContain("border-radius:20px");
      expect(html).toContain("border:6px solid var(--color-text)");
      expect(html).toContain("transform:rotate(2deg)"); // card 0 leans right…
      expect(html).toContain("transform:rotate(-2deg)"); // …card 1 leans left
      const m = /width:(\d+)px;height:(\d+)px;border-radius:20px/.exec(html);
      expect(m).not.toBeNull();
      expect(Number(m![1])).toBe(Math.round(Number(m![2]) * (4 / 3)));
    }
  });

  it("caption pills ride IN the card element and rotate by card index: coral, mint, yellow", () => {
    const html = bubblegumVocabulary.renderPhotoBand({
      items: items(3),
      register: "M",
      bandHeight: 260,
      bandWidth: 992,
      mode: "static",
      uid: "b1",
    });
    const caps = [
      ...html.matchAll(
        /margin-top:8px;max-width:100%;background:var\(--color-([a-z-]+)\);color:var\(--color-bg\);border-radius:999px/g,
      ),
    ];
    expect(caps.map((c) => c[1])).toEqual(["accent", "accent-strong", "price"]);
    expect(html).toContain("Dish 0");
  });

  it("header: compact row (150px portrait / 104px landscape), Anton near-white title with a sparkle flourish, logo on a rounded surface chip", () => {
    const shell = (canvas: { width: number; height: number }): string =>
      bubblegumVocabulary.renderShell({
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
      expect(html).toContain("color:var(--color-text)"); // near-white title on the grape stage
      expect(html).toContain('fill="var(--color-price)"'); // the 4-point flourish by the title
      // the logo's rounded surface chip wraps the placeholder
      expect(html).toMatch(
        /background:var\(--color-surface\);border-radius:18px;[^"]*"[^>]*>\s*<img data-brand-logo/,
      );
    }
    // No brand → a rounded bordered placeholder box instead.
    const bare = bubblegumVocabulary.renderShell({
      title: "Board",
      tagline: null,
      canvas: PORTRAIT,
      register: "M",
      bodyHtml: "",
    });
    expect(bare).toContain("border-radius:16px");
    expect(bare).toContain("border:3px solid var(--color-surface-strong)");
  });

  it("landscape shell wraps the body in ONE big rounded sticker card (32px); portrait cards sit directly on the stage", () => {
    const shell = (canvas: { width: number; height: number }): string =>
      bubblegumVocabulary.renderShell({
        title: "Board",
        tagline: null,
        canvas,
        register: "M",
        bodyHtml: "<div>BODY</div>",
      });
    const landscape = shell(LANDSCAPE);
    expect(landscape).toMatch(
      /background:var\(--color-surface\);border-radius:32px;[\s\S]*<div>BODY<\/div>/,
    );
    // Portrait: the sections are already sticker cards — the shell adds no card of its own.
    const portrait = shell(PORTRAIT);
    expect(portrait).not.toContain("border-radius:32px");
    expect(portrait).toContain("<div>BODY</div>");
  });

  it("portrait contentBox subtracts header + margins exactly", () => {
    const box = bubblegumVocabulary.contentBox(PORTRAIT);
    // 1080 − 2×44 side margins; 1920 − 150 header − 24 top − 36 bottom
    expect(box).toEqual({ width: 992, height: 1710 });
  });

  it("landscape contentBox subtracts the big card's padding exactly and still affords 4 columns at 420px", () => {
    const box = bubblegumVocabulary.contentBox(LANDSCAPE);
    // 1920 − 2×26 margins − 2×26 card padding; 1080 − 104 header − 16 − 22 − 2×26
    expect(box).toEqual({ width: 1816, height: 886 });
    const fourColWidth = Math.floor((box.width - 3 * 44) / 4);
    expect(fourColWidth).toBeGreaterThanOrEqual(bubblegumVocabulary.minStreamWidth);
  });

  it("stage decor: tiny margin sparkles in the candy palette (portrait 4 + flourish, landscape 3 + flourish)", () => {
    const count = (canvas: { width: number; height: number }): number =>
      [
        ...bubblegumVocabulary
          .renderShell({ title: "B", tagline: null, canvas, register: "M", bodyHtml: "" })
          .matchAll(/<path d="M12 0C13\.4/g),
      ].length;
    expect(count(PORTRAIT)).toBe(5);
    expect(count(LANDSCAPE)).toBe(4);
  });

  it("continuation cue: muted Inter italic beside a CHUNKY 4px fully-rounded bar", () => {
    const cue = bubblegumVocabulary.renderContinuationCue({
      sectionTitle: "Tandoor Mains",
      register: "M",
    });
    expect(cue).toContain("font-style:italic");
    expect(cue).toContain("color:var(--color-muted)");
    expect(cue).toContain("Tandoor Mains (cont.)");
    expect(cue).toContain(
      "height:4px;border-radius:999px;background:color-mix(in srgb,var(--color-muted) 40%,transparent)",
    );
    expect(cue).not.toMatch(/border-bottom/); // never a thin rule
  });

  it("header shrinks long titles to one line in Anton", () => {
    const size = (title: string): number =>
      Number(
        /font-family:'Anton',sans-serif;font-size:(\d+)px/.exec(
          bubblegumVocabulary.renderShell({
            title,
            tagline: null,
            canvas: PORTRAIT,
            register: "M",
            bodyHtml: "",
          }),
        )?.[1],
      );
    expect(size("Tiffin")).toBe(66);
    expect(size("The Grand Imperial Bubblegum Pavilion & Soda House")).toBeLessThan(66);
    expect(size("The Grand Imperial Bubblegum Pavilion & Soda House")).toBeGreaterThanOrEqual(30);
  });
});
