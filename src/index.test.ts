import { describe, expect, it } from "vitest";

import { VERSION } from "./index";

describe("content-engine scaffold", () => {
  it("exposes a version", () => {
    expect(VERSION).toBe("0.1.0");
  });
});
