import { afterEach, describe, expect, it } from "vitest";

import { NodeImageFetcher } from "./image-fetcher";

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);

function resp(buf: Buffer, contentType: string | null, ok = true): Response {
  return {
    ok,
    status: ok ? 200 : 404,
    headers: { get: (k: string) => (k.toLowerCase() === "content-type" ? contentType : null) },
    arrayBuffer: async () =>
      buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer,
  } as unknown as Response;
}

describe("NodeImageFetcher (hermetic, mocked fetch)", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it("assembles a data-URI from the Content-Type header + bytes", async () => {
    globalThis.fetch = (async () => resp(PNG, "image/png")) as typeof fetch;
    const out = await new NodeImageFetcher().fetch(["https://host/a.png"]);
    expect(out.get("https://host/a.png")).toBe(`data:image/png;base64,${PNG.toString("base64")}`);
  });

  it("sniffs MIME from magic bytes when the Content-Type is unhelpful", async () => {
    globalThis.fetch = (async () => resp(JPG, "application/octet-stream")) as typeof fetch;
    const out = await new NodeImageFetcher().fetch(["https://host/a"]);
    expect(out.get("https://host/a")).toMatch(/^data:image\/jpeg;base64,/);
  });

  it("omits non-ok, thrown, and oversized responses (caller substitutes a placeholder)", async () => {
    globalThis.fetch = (async (url: string) => {
      if (url.endsWith("404")) return resp(PNG, "image/png", false);
      if (url.endsWith("boom")) throw new Error("network down");
      return resp(Buffer.alloc(10), "image/png"); // 10 bytes — over the tiny cap below
    }) as typeof fetch;
    const out = await new NodeImageFetcher({ maxBytes: 5 }).fetch([
      "https://host/404",
      "https://host/boom",
      "https://host/big",
    ]);
    expect(out.size).toBe(0);
  });

  it("de-duplicates URLs and skips already-inline refs", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return resp(PNG, "image/png");
    }) as typeof fetch;
    const out = await new NodeImageFetcher().fetch([
      "https://host/a",
      "https://host/a",
      "data:image/png;base64,AAAA",
    ]);
    expect(calls).toBe(1);
    expect(out.has("data:image/png;base64,AAAA")).toBe(false);
    expect(out.get("https://host/a")).toMatch(/^data:image\/png;base64,/);
  });
});
