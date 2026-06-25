import { describe, expect, it } from "vitest";

import {
  ConfigError,
  ContentEngineError,
  LlmContractError,
  PackagingError,
  PaintError,
  QaBudgetError,
  RenderError,
  ThemeNotFoundError,
  UnsupportedConstraintError,
  ValidationError,
} from "./errors";

describe("error hierarchy", () => {
  const cases: [new (m: string) => ContentEngineError, string][] = [
    [ValidationError, "VALIDATION"],
    [UnsupportedConstraintError, "UNSUPPORTED_CONSTRAINT"],
    [ThemeNotFoundError, "THEME_NOT_FOUND"],
    [PaintError, "PAINT"],
    [PackagingError, "PACKAGING"],
    [RenderError, "RENDER"],
    [LlmContractError, "LLM_CONTRACT"],
    [QaBudgetError, "QA_BUDGET"],
    [ConfigError, "CONFIG"],
  ];

  it.each(cases)("%p carries the right code and is a ContentEngineError", (Ctor, code) => {
    const err = new Ctor("boom");
    expect(err).toBeInstanceOf(ContentEngineError);
    expect(err).toBeInstanceOf(Error);
    expect(err.code).toBe(code);
    expect(err.name).toBe(Ctor.name);
    expect(err.message).toBe("boom");
  });

  it("propagates cause and details", () => {
    const cause = new Error("root");
    const err = new RenderError("failed", { cause, details: { a: 1 } });
    expect(err.cause).toBe(cause);
    expect(err.details).toEqual({ a: 1 });
  });

  it("supports instanceof narrowing of the base type", () => {
    const err: unknown = new PaintError("x");
    expect(err instanceof ContentEngineError).toBe(true);
    if (err instanceof ContentEngineError) expect(err.code).toBe("PAINT");
  });
});
