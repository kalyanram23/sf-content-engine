import { describe, expect, it } from "vitest";

import { ValidationError } from "../domain/errors";
import type { CanonicalItem } from "../domain/types";
import { cleanObservation } from "../testing/fakes/browser";
import { createFakeEngine } from "../testing/fakes/index";

/**
 * e2e (fake engine) coverage for the menu data-quality lint + zeroPriceRender policy (D29). A
 * customer-facing board must never show `$0.00`; these prove the "hide" policy flows coherently
 * through paint AND binding QA (no fight), and that `mode` reject/warn is honoured on both paths.
 */

/** A drinks menu with a well-priced item and a zero-price item (the observed "$0.00" bug seed). */
const menu: CanonicalItem[] = [
  { id: "a", name: "Latte", category: "drinks", available: true, price: 4.5 },
  { id: "z", name: "Tap Water", category: "drinks", available: true, price: 0 },
];

const plan = {
  screens: [
    {
      id: "screen-1",
      sections: [{ title: "DRINKS", representation: "list" as const, items: ["a", "z"] }],
    },
  ],
};

const input = {
  items: menu,
  brief: { presetId: "botanical" },
  constraints: { aspect: "16:9" as const, screens: 1 },
  plan,
};

/** Extract one item's node markup (fake painter emits `<article … data-item-id="z">…</article>`). */
function itemNode(html: string, id: string): string {
  return html.match(new RegExp(`data-item-id="${id}"[\\s\\S]*?</article>`))?.[0] ?? "";
}

describe("menu-lint e2e (D29)", () => {
  it("default policy ships a zero-price item with NO price element and no $0.00, and QA still passes", async () => {
    const engine = createFakeEngine({ observations: [cleanObservation()] });
    const out = await engine.generate(input);

    const report = out.qaReport.screens[0]!;
    expect(report.passed).toBe(true);
    // The "hide" policy did not fight binding QA: no blocking binding/other findings survived.
    expect(
      report.findings.filter((f) => f.severity === "major" || f.severity === "critical"),
    ).toHaveLength(0);

    const html = out.screens[0]!.html;
    // The zero-price item still renders (coverage untouched) but carries NO price element.
    expect(html).toContain('data-item-id="z"');
    expect(html).not.toContain("$0.00");
    expect(itemNode(html, "z")).not.toContain('data-bind="price"');
    // The genuinely-priced sibling is unaffected.
    expect(html).toContain("$4.50");
    expect(itemNode(html, "a")).toContain('data-bind="price"');
  });

  it("surfaces the lint findings on qaReport.menuLint (warn mode, default)", async () => {
    const engine = createFakeEngine({ observations: [cleanObservation()] });
    const out = await engine.generate(input);

    expect(out.qaReport.menuLint).toBeDefined();
    expect(out.qaReport.menuLint).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "price-zero", itemId: "z" })]),
    );
  });

  it('mode:"reject" throws a ValidationError listing the findings, before rendering', async () => {
    const engine = createFakeEngine({
      observations: [cleanObservation()],
      config: { menuLint: { mode: "reject" } },
    });
    await expect(engine.generate(input)).rejects.toBeInstanceOf(ValidationError);
    await expect(engine.generate(input)).rejects.toThrow(/price-zero/);
  });

  it('mode:"reject" is honoured on the plan() path too', async () => {
    const engine = createFakeEngine({ config: { menuLint: { mode: "reject" } } });
    await expect(engine.plan(input)).rejects.toBeInstanceOf(ValidationError);
  });

  it('zeroPriceRender:"verbatim" renders $0.00 verbatim (policy is independent of mode)', async () => {
    const engine = createFakeEngine({
      observations: [cleanObservation()],
      config: { menuLint: { zeroPriceRender: "verbatim" } },
    });
    const out = await engine.generate(input);

    const html = out.screens[0]!.html;
    expect(out.qaReport.screens[0]!.passed).toBe(true);
    // Verbatim keeps the $0.00 (and its binding, matching the source 0) — the pipeline no longer hides it.
    expect(html).toContain("$0.00");
    expect(itemNode(html, "z")).toContain('data-bind="price"');
    // mode is still the default "warn", so the lint is still surfaced — the two knobs are orthogonal.
    expect(out.qaReport.menuLint).toEqual(
      expect.arrayContaining([expect.objectContaining({ kind: "price-zero", itemId: "z" })]),
    );
  });

  it('mode:"off" stays silent on the report but still hides the $0.00 (default zeroPriceRender)', async () => {
    const engine = createFakeEngine({
      observations: [cleanObservation()],
      config: { menuLint: { mode: "off" } },
    });
    const out = await engine.generate(input);

    expect(out.qaReport.menuLint).toBeUndefined();
    expect(out.screens[0]!.html).not.toContain("$0.00");
    expect(out.qaReport.screens[0]!.passed).toBe(true);
  });

  it("does not surface menuLint for a clean menu (warn mode, nothing flagged)", async () => {
    const clean: CanonicalItem[] = [
      { id: "a", name: "Latte", category: "drinks", available: true, price: 4.5 },
    ];
    const engine = createFakeEngine({ observations: [cleanObservation()] });
    const out = await engine.generate({
      ...input,
      items: clean,
      plan: {
        screens: [
          {
            id: "screen-1",
            sections: [{ title: "DRINKS", representation: "list" as const, items: ["a"] }],
          },
        ],
      },
    });
    expect(out.qaReport.menuLint).toBeUndefined();
  });
});
