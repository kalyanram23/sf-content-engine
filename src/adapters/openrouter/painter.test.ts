import { describe, expect, it } from "vitest";

import { describeLayoutStrategy, extractScreenHtml } from "./painter";

/**
 * Hermetic (no network): guards how we pull the screen markup out of a model response. The painter
 * model occasionally disobeys "return ONLY the HTML, no fences" — on a re-paint it can emit its QA
 * reasoning as a prose preamble before a ```html block. None of that may leak into the page.
 */
describe("extractScreenHtml", () => {
  it("returns bare HTML untouched", () => {
    expect(extractScreenHtml("<div>hi</div>")).toBe("<div>hi</div>");
  });

  it("strips a leading ```html fence", () => {
    expect(extractScreenHtml("```html\n<section>x</section>\n```")).toBe("<section>x</section>");
  });

  it("ignores a prose preamble before a fenced block (the board-2 regression)", () => {
    const raw =
      "Looking at the two QA findings: 1. Contrast 1.38:1 on a span. 2. Overflow 0x369px. Fix: lock root.\n\n" +
      '```html\n<div class="root"><h1>VEG CURRIES</h1></div>\n```';
    expect(extractScreenHtml(raw)).toBe('<div class="root"><h1>VEG CURRIES</h1></div>');
  });

  it("drops prose before the first tag even when the model omits the fence", () => {
    const raw = "Here is the screen: <main><h1>BIRYANI & PULAV</h1></main>";
    expect(extractScreenHtml(raw)).toBe("<main><h1>BIRYANI & PULAV</h1></main>");
  });

  it("strips a dangling ```html marker with no closing fence", () => {
    expect(extractScreenHtml("Sure!\n```html\n<div>x</div>")).toBe("<div>x</div>");
  });
});

/**
 * The per-board layout guidance must make representation/layoutHint authoritative: a matrix/table
 * board gets matrix-first guidance with a single shared hero (the photo-grid-per-item language is
 * suppressed), while any other board keeps the photo-grid + per-section hero language. Proves the
 * conditional branches both ways so neither path regresses.
 */
describe("describeLayoutStrategy", () => {
  const matrixBoard = {
    id: "screen-1",
    sections: [
      {
        title: "BIRYANI & PULAV",
        representation: "matrix" as const,
        items: ["a1", "a2", "a3"],
        layoutHint: "rows = base dish, columns = Biryani | Pulav",
      },
    ],
  };
  const photoBoard = {
    id: "screen-2",
    sections: [{ title: "CURRIES", representation: "grid" as const, items: ["b1", "b2"] }],
  };

  it("emits matrix-first guidance + a single shared hero, suppressing the photo-grid language", () => {
    const s = describeLayoutStrategy(matrixBoard);
    expect(s).toContain("MATRIX/TABLE FIRST");
    expect(s).toContain("ONE shared compact rotating hero");
    expect(s).not.toContain("PHOTO-LED GRID");
    expect(s).not.toContain("Give EVERY item its own large card");
  });

  it("emits photo-grid + per-section hero language for a non-matrix board", () => {
    const s = describeLayoutStrategy(photoBoard);
    expect(s).toContain("PHOTO-LED GRID");
    expect(s).toContain("Give EVERY item its own large card");
    expect(s).toContain("rotating hero");
    expect(s).not.toContain("MATRIX/TABLE FIRST");
  });

  it("detects a matrix board from the layoutHint even when representation is not matrix", () => {
    const board = {
      id: "screen-3",
      sections: [
        {
          title: "PRICES",
          representation: "grid" as const,
          items: ["c1"],
          layoutHint: "a price table: rows x columns",
        },
      ],
    };
    expect(describeLayoutStrategy(board)).toContain("MATRIX/TABLE FIRST");
  });
});
