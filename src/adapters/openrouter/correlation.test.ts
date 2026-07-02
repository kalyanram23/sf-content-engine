import { describe, expect, it } from "vitest";

import { buildBroadcast } from "./correlation";

describe("buildBroadcast (OpenRouter Broadcast correlation)", () => {
  it("composes session_id as slug:screen:run from a full correlation", () => {
    const { sessionId } = buildBroadcast(
      {
        runId: "run-abc",
        restaurant: "Bismillah Biryani House",
        screenId: "screen-3",
        iteration: 2,
      },
      "paint",
    );
    expect(sessionId).toBe("bismillah-biryani-house:screen-3:run-abc");
  });

  it("defaults the restaurant slug to 'menu' when none is given", () => {
    const { sessionId } = buildBroadcast({ runId: "run-abc", screenId: "screen-1" }, "paint");
    expect(sessionId).toBe("menu:screen-1:run-abc");
  });

  it("uses the role in place of a screen for a board-less call (e.g. the planner)", () => {
    const { sessionId } = buildBroadcast({ runId: "run-abc", restaurant: "Cafe" }, "plan");
    expect(sessionId).toBe("cafe:plan:run-abc");
  });

  it("omits session_id when there is no runId (nothing to make it unique)", () => {
    const { sessionId } = buildBroadcast({ restaurant: "Cafe", screenId: "screen-1" }, "paint");
    expect(sessionId).toBeUndefined();
  });

  it("stamps the trace with the human-readable name, role, board, and iteration", () => {
    const { trace } = buildBroadcast(
      {
        runId: "run-abc",
        restaurant: "Bismillah Biryani House",
        screenId: "screen-3",
        iteration: 2,
      },
      "paint",
    );
    expect(trace).toEqual({
      trace_name: "content-engine",
      trace_id: "run-abc",
      role: "paint",
      restaurant: "Bismillah Biryani House",
      board: "screen-3",
      iteration: 2,
    });
  });

  it("returns no fields when there is no correlation at all", () => {
    expect(buildBroadcast(undefined, "paint")).toEqual({});
  });
});
