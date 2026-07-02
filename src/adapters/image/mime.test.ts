import { describe, expect, it } from "vitest";
import { sniffMime, mimeFor, mimeForPath } from "./mime";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const SVG = Buffer.from("<svg xmlns='http://www.w3.org/2000/svg'></svg>", "utf8");

describe("mime helpers", () => {
  it("sniffs a PNG by magic bytes", () => {
    expect(sniffMime(PNG)).toBe("image/png");
  });
  it("sniffs an SVG by leading tag", () => {
    expect(sniffMime(SVG)).toBe("image/svg+xml");
  });
  it("trusts a declared image content-type", () => {
    expect(mimeFor("image/webp; charset=x", PNG)).toBe("image/webp");
  });
  it("falls back to sniffing when content-type is non-image", () => {
    expect(mimeFor("application/octet-stream", PNG)).toBe("image/png");
  });
  it("maps a file extension to a mime, ignoring bytes", () => {
    expect(mimeForPath("/logo/brand.svg", Buffer.from("x"))).toBe("image/svg+xml");
    expect(mimeForPath("/logo/brand.PNG", PNG)).toBe("image/png");
  });
  it("sniffs bytes when the extension is unknown", () => {
    expect(mimeForPath("/logo/brand.bin", PNG)).toBe("image/png");
  });
});
