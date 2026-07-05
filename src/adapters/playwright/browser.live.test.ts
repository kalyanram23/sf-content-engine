import { inflateSync } from "node:zlib";

import { describe, expect, it } from "vitest";

import { PlaywrightBrowser } from "./browser";

/**
 * Live browser test. Run with `RUN_BROWSER_TESTS=1 npm run test:live` after
 * `npx playwright install chromium`. Skips otherwise so the suite is safe anywhere.
 */
const RUN = Boolean(process.env["RUN_BROWSER_TESTS"]);

/**
 * Minimal PNG decoder for the settle test: returns true if the image has a "dark" pixel (all RGB
 * channels below `threshold`). Handles 8-bit truecolour (RGB / RGBA) with per-scanline filtering —
 * exactly what headless Chromium's `type:"png"` screenshot emits. A ghost frame captured mid-fade
 * (wrapper at ~0% opacity over a white body) is near-uniform white and has NO dark pixel; the
 * settled frame shows the black label text and does.
 */
function pngHasDarkPixel(png: Buffer, threshold = 96): boolean {
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  let offset = 8; // skip the 8-byte PNG signature
  while (offset + 8 <= png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data.readUInt8(8);
      colorType = data.readUInt8(9);
    } else if (type === "IDAT") {
      idat.push(data);
    } else if (type === "IEND") {
      break;
    }
    offset += 12 + length; // length(4) + type(4) + data + crc(4)
  }
  if (bitDepth !== 8 || (colorType !== 2 && colorType !== 6)) {
    throw new Error(`unsupported PNG for this test (bitDepth ${bitDepth}, colorType ${colorType})`);
  }
  const channels = colorType === 6 ? 4 : 3;
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const paeth = (a: number, b: number, c: number): number => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  let prev = new Uint8Array(stride);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[pos] ?? 0;
    pos += 1;
    const cur = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[pos + x] ?? 0;
      const a = x >= channels ? (cur[x - channels] ?? 0) : 0;
      const b = prev[x] ?? 0;
      const c = x >= channels ? (prev[x - channels] ?? 0) : 0;
      let val: number;
      switch (filter) {
        case 1:
          val = rawByte + a;
          break;
        case 2:
          val = rawByte + b;
          break;
        case 3:
          val = rawByte + ((a + b) >> 1);
          break;
        case 4:
          val = rawByte + paeth(a, b, c);
          break;
        default:
          val = rawByte;
          break;
      }
      cur[x] = val & 0xff;
    }
    pos += stride;
    for (let x = 0; x + channels <= stride; x += channels) {
      if (
        (cur[x] ?? 255) < threshold &&
        (cur[x + 1] ?? 255) < threshold &&
        (cur[x + 2] ?? 255) < threshold
      ) {
        return true;
      }
    }
    prev = cur;
  }
  return false;
}

describe.skipIf(!RUN)("PlaywrightBrowser (live)", () => {
  it("renders at the EXACT viewport/DPR and observes real content", async () => {
    const browser = new PlaywrightBrowser({ launchArgs: ["--no-sandbox"] });
    const html =
      `<!doctype html><html><head><style>body{margin:0}.box{width:100vw;height:100vh;background:#000}` +
      `.label{color:#fff;font-size:40px}</style></head>` +
      `<body><div class="box"><p class="label">Hello</p></div></body></html>`;

    const { observation, screenshotBase64 } = await browser.render({
      html,
      viewport: { width: 1280, height: 720, dpr: 1 },
    });

    expect(observation.actualViewport).toEqual({ width: 1280, height: 720, dpr: 1 });
    expect(screenshotBase64.length).toBeGreaterThan(0);
    expect(observation.fillRatio).toBeGreaterThan(0);
    expect(observation.textSamples.length).toBeGreaterThan(0);
  });

  it("settles a painter-authored CSS entrance animation to its final frame before capture", async () => {
    const browser = new PlaywrightBrowser({ launchArgs: ["--no-sandbox"] });
    // A raw CSS entrance animation on the board wrapper (as a painter might author) with a LONG
    // duration: at t≈0 the wrapper is opacity:0 (from{opacity:0}), so a naive screenshot ~60ms after
    // load would capture a near-blank frame. render() must jump the animation to its end (opacity:1)
    // so QA grades the settled steady-state frame the TV actually shows, not the entrance frame.
    const html =
      `<!doctype html><html><head><style>body{margin:0;background:#fff}` +
      `@keyframes fadeIn{from{opacity:0}to{opacity:1}}` +
      `.wrap{width:100vw;height:100vh;animation:fadeIn 300s linear both}` +
      `.label{color:#000;font-size:64px;font-weight:700}</style></head>` +
      `<body><div class="wrap"><p class="label">SETTLED FRAME</p></div></body></html>`;

    const { screenshotBase64 } = await browser.render({
      html,
      viewport: { width: 1280, height: 720, dpr: 1 },
    });

    // The settled frame shows the black label; a ghost frame captured at ~0% opacity over the white
    // body would be uniform white with no dark pixel.
    expect(pngHasDarkPixel(Buffer.from(screenshotBase64, "base64"))).toBe(true);
  });
});
