import { describe, expect, it } from "vitest";

import { PLACEHOLDER_IMAGE_DATA_URI } from "../../util/placeholder-image";
import { FakeImageFetcher } from "./image-fetcher";

describe("FakeImageFetcher", () => {
  it("maps every URL to a valid data-URI (hermetic, no network)", async () => {
    const out = await new FakeImageFetcher().fetch(["https://a/1.jpg", "https://b/2.png"]);
    expect(out.get("https://a/1.jpg")).toBe(PLACEHOLDER_IMAGE_DATA_URI);
    expect(out.get("https://b/2.png")).toBe(PLACEHOLDER_IMAGE_DATA_URI);
    expect(PLACEHOLDER_IMAGE_DATA_URI.startsWith("data:image/png;base64,")).toBe(true);
  });
});
