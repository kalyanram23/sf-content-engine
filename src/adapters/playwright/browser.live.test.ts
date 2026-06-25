import { describe, expect, it } from "vitest";

import { PlaywrightBrowser } from "./browser";

/**
 * Live browser test. Run with `RUN_BROWSER_TESTS=1 npm run test:live` after
 * `npx playwright install chromium`. Skips otherwise so the suite is safe anywhere.
 */
const RUN = Boolean(process.env["RUN_BROWSER_TESTS"]);

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
});
