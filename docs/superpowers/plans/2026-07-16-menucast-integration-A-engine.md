# Plan A — Engine work items for the menu-cast integration

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make content-engine's output patchable and size-aware enough for menu-cast's serve-time
overlay: per-size prices rendered and tagged on composed boards, name hooks on every item, the
sold-out token pinned, and single-screen (sliced-plan) invocation verified.

**Architecture:** All changes ride existing seams — the shared vocabulary binding kit
(`src/vocabularies/shared/binding.ts`), the vocabulary contract test suite
(`src/vocabularies/shared/contract.testkit.ts`), the config-driven binding enforcement
(`src/config/qa.ts` → `src/qa/structural-checks.ts`), and the free-paint prompt contract
(`src/adapters/openrouter/painter.ts`, `src/config/layouts.ts`). No new subsystems.

**Tech Stack:** TypeScript ESM, Zod 4, vitest (hermetic fakes), node-html-parser.

**Spec:** `docs/superpowers/specs/2026-07-13-menucast-integration-design.md` §9 (work items), §4
(overlay contract these items serve).

## Global Constraints

- `npm run verify` green before every claim of done (prettier → eslint → tsc → vitest, hermetic).
- Zod 4 idioms: `z.toJSONSchema`, `.prefault({})` for all-defaulted nested objects.
- tsconfig strictness: `import type` for types; no `{ field: undefined }` (spread conditionally);
  bracket-access for index signatures.
- Only `src/node.ts` + `src/adapters/**` may import optional peers — none of this plan touches that
  boundary.
- LLM contracts (`src/domain/contracts.ts`) must stay `additionalProperties:false`-compatible —
  this plan does NOT change contracts (VocabItem is an internal port type, not an LLM contract).
- Dhaba's vocabulary keeps its own PRIVATE binding helpers on purpose (D78 reference
  implementation) — edit its copies in place; do not import the shared kit into it.
- The composed renderer never invents copy: size labels/prices come from `CanonicalItem.sizes`
  verbatim.

---

### Task A1: Sized prices on composed boards — `VocabItem.sizes` + shared rendering helper

Composed boards currently map `CanonicalItem` → `VocabItem { price: number|null }`
(`src/composition/digest.ts:47-52`), so an item priced per-size (`price` absent, `sizes[]`
present) renders as "MP". menu-cast menus are full of sized items; composed is the launch path.
Give vocabularies the size data and one shared way to render + tag it.

**Files:**
- Modify: `src/ports/vocabulary-registry.ts` (VocabItem, ~line 8)
- Modify: `src/composition/digest.ts:31-52` (money + toVocabItem)
- Modify: `src/vocabularies/shared/binding.ts` (new `bindPrices` helper)
- Test: `src/vocabularies/shared/binding.test.ts`
- Test: `src/composition/digest.test.ts` (exists — extend; if the digest tests live elsewhere,
  `grep -rn "buildComposerContent" src --include="*.test.ts"` and extend that file)

**Interfaces:**
- Consumes: `CanonicalItem.sizes?: { label: string; price: number }[]` (existing domain schema).
- Produces (later tasks + menu-cast overlay rely on these exact shapes):
  - `VocabItem.sizes?: { label: string; price: number }[]`
  - `bindPrices(item: Pick<VocabItem, "price" | "sizes">, style: string): string` — returns either
    the single `<span data-bind="price" …>` (existing behavior) or, for a sized item, one
    `<span data-bind="price" data-size="<escaped label>" …>$X.YY</span>` per size joined with a
    `<span … aria-hidden="true"> · </span>` separator, each label prefixed inside the span as
    `<i>` -free plain text: `S $5.00`.
  - Digest line for sized items becomes `Name S $5.00 / M $7.00` (composer sees real prices, not MP).

- [ ] **Step 1: Write the failing tests**

In `src/vocabularies/shared/binding.test.ts` add:

```ts
import { bindPrices } from "./binding";

describe("bindPrices", () => {
  it("renders a single tagged span for a flat-priced item", () => {
    const html = bindPrices({ price: 9.5 }, "color:var(--color-price)");
    expect(html).toBe('<span data-bind="price" style="color:var(--color-price)">$9.50</span>');
  });

  it("renders MP for a null price (market price)", () => {
    expect(bindPrices({ price: null }, "x")).toContain(">MP<");
  });

  it("renders one span per size, tagged data-size with QA-exact escaping", () => {
    const html = bindPrices(
      { price: null, sizes: [{ label: 'Sm "cup"', price: 5 }, { label: "Lg", price: 7.25 }] },
      "s",
    );
    const spans = [...html.matchAll(/<span data-bind="price" data-size="([^"]*)"[^>]*>([^<]*)</g)];
    expect(spans.map((m) => m[1])).toEqual(["Sm &quot;cup&quot;", "Lg"]);
    expect(spans[0]![2]).toBe('Sm "cup" $5.00'.replace(/"/g, "&quot;"));
    expect(spans[1]![2]).toBe("Lg $7.25");
  });

  it("prefers sizes over a base price when both exist", () => {
    const html = bindPrices({ price: 4, sizes: [{ label: "S", price: 5 }] }, "s");
    expect(html).not.toContain(">$4.00<");
    expect(html).toContain('data-size="S"');
  });
});
```

In the digest test file add:

```ts
it("maps CanonicalItem.sizes onto VocabItem.sizes and prices the digest per size", () => {
  const content = buildComposerContent({
    planScreen: {
      id: "s1",
      sections: [{ title: "Chai", representation: "list", items: ["c1"] }],
    },
    items: [
      { id: "c1", name: "Masala Chai", available: true,
        sizes: [{ label: "Cutting", price: 2 }, { label: "Full", price: 3.5 }] },
    ],
    vocab: dhabaVocabulary,
  });
  expect(content.sections[0]!.items[0]!.sizes).toEqual([
    { label: "Cutting", price: 2 },
    { label: "Full", price: 3.5 },
  ]);
  expect(content.digest).toContain("Cutting $2.00");
  expect(content.digest).not.toContain("MP");
});
```

(Match the existing test file's fixture style for `planScreen`/`items` — reuse its builders if it
has them.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/vocabularies/shared/binding.test.ts src/composition`
Expected: FAIL — `bindPrices` is not exported; `sizes` missing on VocabItem/digest.

- [ ] **Step 3: Implement**

`src/ports/vocabulary-registry.ts` — extend VocabItem (additive, optional):

```ts
export interface VocabItem {
  id: string;
  name: string;
  /** null = market price (vocabulary renders its MP treatment). Ignored when `sizes` is set. */
  price: number | null;
  /** Per-size prices (e.g. S/M/L). When present, vocabularies render one tagged span per size. */
  sizes?: { label: string; price: number }[];
  /** True when the item has a photo (renderer emits a data-img-item placeholder for it). */
  hasImage: boolean;
  slot?: string; // keep the existing doc comment
}
```

`src/vocabularies/shared/binding.ts` — add below `bindPrice`:

```ts
/**
 * Price markup for an item: a single data-bind="price" span, or — for a sized item — one span per
 * size, each stamped `data-size="<label>"` (the serve-time patcher's per-size selector, spec §4).
 * Sizes win over a base price. Labels are escaped with the QA-exact `esc`.
 */
export const bindPrices = (
  item: Pick<VocabItem, "price" | "sizes">,
  style: string,
): string => {
  if (item.sizes !== undefined && item.sizes.length > 0) {
    return item.sizes
      .map(
        (s) =>
          `<span data-bind="price" data-size="${esc(s.label)}" style="${style}">` +
          `${esc(s.label)} ${money(s.price)}</span>`,
      )
      .join(`<span style="${style}" aria-hidden="true"> · </span>`);
  }
  return bindPrice(item.price === null ? "MP" : money(item.price), style);
};
```

(If `bindPrice` callers currently special-case MP themselves, leave them; `bindPrices` is the new
front door used by Task A2.)

`src/composition/digest.ts` — thread sizes through:

```ts
const money = (price: number | null): string => (price === null ? "MP" : `$${price.toFixed(2)}`);
const sizedMoney = (it: CanonicalItem): string =>
  it.sizes !== undefined && it.sizes.length > 0
    ? it.sizes.map((s) => `${s.label} ${money(s.price)}`).join(" / ")
    : money(it.price ?? null);

const toVocabItem = (it: CanonicalItem): VocabItem => ({
  id: it.id,
  name: cleanName(it.name),
  price: it.price ?? null,
  ...(it.sizes !== undefined && it.sizes.length > 0 ? { sizes: it.sizes } : {}),
  hasImage: hasImage(it),
});
```

and use `sizedMoney(it)` where the digest currently renders `money(it.price)`
(`src/composition/digest.ts:88`).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/vocabularies/shared/binding.test.ts src/composition`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/ports/vocabulary-registry.ts src/composition/digest.ts \
  src/vocabularies/shared/binding.ts src/vocabularies/shared/binding.test.ts src/composition/*.test.ts
git commit -m "feat(composition): sized prices reach vocabularies — VocabItem.sizes + bindPrices with data-size tagging"
```

---

### Task A2: Every vocabulary renders sized prices through `bindPrices`

Wire A1 into all four vocabularies and pin it in the shared contract suite so future vocabularies
inherit the rule. Dhaba edits its private helpers (D78 — do not import the shared kit there).

**Files:**
- Modify: `src/vocabularies/shared/contract.testkit.ts` (new contract test)
- Modify: `src/vocabularies/bazaar/index.ts`, `src/vocabularies/blockframe/index.ts`,
  `src/vocabularies/bold-poster/index.ts` — replace their row-price `bindPrice(...)`/manual span
  call sites with `bindPrices(item, <same style>)`
- Modify: `src/vocabularies/dhaba/index.ts:214-224` — its private price-span builder gains the same
  sizes branch (copy the `bindPrices` body, keep private `esc`/`money`)
- Test: each vocab's `*.test.ts` already calls `describeVocabularyContract` — no per-vocab test
  edits needed

**Interfaces:**
- Consumes: `bindPrices`, `VocabItem.sizes` (A1).
- Produces: every composed item row with sizes renders `data-bind="price" data-size="<label>"`
  spans — the overlay contract for sized items (spec §4) and the shape A3's QA check verifies.

- [ ] **Step 1: Write the failing contract test**

In `describeVocabularyContract` (`src/vocabularies/shared/contract.testkit.ts`), after the
"renderSection stamps data-item-id…" test, add:

```ts
it("renders per-size tagged price spans for sized items (patcher contract, spec §4)", () => {
  const sized: VocabItem[] = [
    {
      id: "sz0",
      name: "Paneer Tikka",
      price: null,
      sizes: [
        { label: "Half", price: 6.5 },
        { label: "Full", price: 11 },
      ],
      hasImage: false,
    },
  ];
  const outputs = [
    vocab.renderSection({ number: 1, section: { title: "Grill", items: sized }, internalCols: 1, register: mid }),
    vocab.renderFlowRow({ item: sized[0]!, register: mid }),
  ];
  for (const html of outputs) {
    expect(html).toContain('data-size="Half"');
    expect(html).toContain('data-size="Full"');
    expect(html).toContain("$6.50");
    expect(html).toContain("$11.00");
    // exactly one data-bind="price" span per size, none unlabelled
    const spans = [...html.matchAll(/data-bind="price"(?: data-size="([^"]*)")?/g)];
    expect(spans.every((m) => m[1] !== undefined)).toBe(true);
  }
});
```

- [ ] **Step 2: Run to verify all four vocab suites fail**

Run: `npx vitest run src/vocabularies`
Expected: FAIL ×4 (dhaba, bazaar, blockframe, bold-poster) — sized spans absent.

- [ ] **Step 3: Wire the vocabularies**

For bazaar/blockframe/bold-poster: import `bindPrices` from `../shared/binding` and replace each
row/lead/flow-row price call site (grep `bindPrice(` and manual `data-bind="price"` spans in each
`index.ts`) with `bindPrices(item, <the exact style string already there>)`.

For dhaba (`src/vocabularies/dhaba/index.ts` around lines 214-224), extend its private builder:

```ts
const priceSpan = (item: VocabItem, nameSize: number): string => {
  const style = `font-size:${nameSize}px;font-weight:800;color:var(--color-price);font-variant-numeric:tabular-nums`;
  if (item.sizes !== undefined && item.sizes.length > 0) {
    return item.sizes
      .map(
        (s) =>
          `<span data-bind="price" data-size="${esc(s.label)}" style="${style}">` +
          `${esc(s.label)} ${money(s.price)}</span>`,
      )
      .join(`<span style="${style}" aria-hidden="true"> · </span>`);
  }
  return item.price === null
    ? `<span data-bind="price" style="font-size:${Math.round(nameSize * 0.7)}px;font-weight:800;color:var(--color-price);border:2px solid var(--color-price);padding:0 6px">MP</span>`
    : `<span data-bind="price" style="${style}">${money(item.price)}</span>`;
};
```

and route dhaba's existing call sites through it (keep its current MP/price styling verbatim for
the unsized branch).

- [ ] **Step 4: Run to verify pass**

Run: `npx vitest run src/vocabularies`
Expected: PASS (all vocab contract suites).

- [ ] **Step 5: Commit**

```bash
git add src/vocabularies
git commit -m "feat(vocabularies): sized items render per-size tagged prices in all four vocabularies + contract test"
```

---

### Task A3: Per-size price verification in structural QA + free-paint matrix data-size

QA today checks that all expected prices appear *somewhere* in an item's price spans
(`src/qa/structural-checks.ts:168-184`). Upgrade: when an item has `sizes`, each size's price must
sit in a span tagged with that size's label — so a bake is guaranteed overlay-patchable per size.
Free-paint matrix cells get the same tag via the skeleton + prompt contract.

**Files:**
- Modify: `src/qa/structural-checks.ts:146-188` (checkBindings price branch)
- Modify: `src/config/layouts.ts` MATRIX_SKELETON (~line 24) — price span gains
  `data-size="Biryani"` (the cell's column), i.e. `<span data-bind="price" data-size="Biryani">$0.00</span>`
- Modify: `src/adapters/openrouter/painter.ts:71` and the matrix directive text (~:245-248) — add
  the data-size requirement sentences (exact text in Step 3)
- Modify: `src/testing/fakes/painter.ts:56-70` — FakePainter's per-size spans gain
  `data-size="${esc(s.label)}"`
- Test: `src/qa/structural-checks.test.ts` (extend the checkBindings describe block)

**Interfaces:**
- Consumes: `data-size` spans from A1/A2.
- Produces: finding kind `binding-mismatch` now also fires per size:
  `Item "<id>" size "<label>" has no data-bind="price" span tagged data-size="<label>" …`.
  menu-cast's overlay may rely on: for every `CanonicalItem.sizes[].label` there exists
  `[data-item-id="<id>"] [data-bind="price"][data-size="<label>"]` in every PASSING bake.

- [ ] **Step 1: Write the failing tests**

In `src/qa/structural-checks.test.ts` (reuse its existing helpers for building ctx/root — grep
`checkBindings(` there for the established pattern):

```ts
it("flags a sized item whose size span is missing or mistagged", () => {
  const html = `<div data-item-id="sz1">
    <span data-bind="price" data-size="Half">Half $6.50</span>
    <span data-bind="price">$11.00</span></div>`; // Full untagged
  const findings = runCheckBindings(html, {
    items: [{ id: "sz1", name: "X", available: true,
      sizes: [{ label: "Half", price: 6.5 }, { label: "Full", price: 11 }] }],
    plannedIds: ["sz1"],
  });
  expect(findings.map((f) => f.kind)).toContain("binding-mismatch");
  expect(findings.find((f) => f.kind === "binding-mismatch")!.message).toContain('"Full"');
});

it("passes a sized item with one correctly tagged span per size", () => {
  const html = `<div data-item-id="sz1">
    <span data-bind="price" data-size="Half">Half $6.50</span>
    <span data-bind="price" data-size="Full">Full $11.00</span></div>`;
  const findings = runCheckBindings(html, {
    items: [{ id: "sz1", name: "X", available: true,
      sizes: [{ label: "Half", price: 6.5 }, { label: "Full", price: 11 }] }],
    plannedIds: ["sz1"],
  });
  expect(findings).toEqual([]);
});
```

(`runCheckBindings` = whatever the file's existing harness is; adapt names, keep the HTML/ctx
payloads exactly as above.)

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/qa/structural-checks.test.ts`
Expected: FAIL — untagged "Full" span currently satisfies the joined-numbers check.

- [ ] **Step 3: Implement**

In `checkBindings`, inside the `if (binding === "price")` branch, after the existing aggregate
check, add the per-size pass:

```ts
const sizes = item?.sizes ?? [];
for (const size of sizes) {
  const span = hooks.find((h) => h.getAttribute("data-size") === size.label);
  const ok = span !== undefined && approxIncludes(numbersIn(span.text), size.price);
  if (!ok) {
    findings.push(
      makeFinding({
        kind: FindingKind.BindingMismatch,
        source: "deterministic",
        severity: "major",
        tag: "content",
        itemId: id,
        message: `Item "${id}" size "${size.label}" has no data-bind="price" span tagged data-size="${size.label}" carrying ${size.price}.`,
        data: { size: size.label, expected: size.price },
      }),
    );
  }
}
```

Painter contract (`painter.ts:71`), append to the existing sentence:

```
Sized items: one <span data-bind="price" data-size="<size label>"> per size (label text verbatim).
```

Matrix directive (`painter.ts:245-248` string): after "the item's real price in its
<span data-bind=\"price\">", change to "…in its <span data-bind=\"price\" data-size=\"<column
label>\"> (data-size = the cell's data-matrix-cell value)". Update `MATRIX_SKELETON` in
`src/config/layouts.ts` to match (filled cell becomes
`<span data-bind="price" data-size="Biryani">$0.00</span>`).

FakePainter (`src/testing/fakes/painter.ts`): sized/variant spans gain the tag, e.g.

```ts
`<span class="text-price" data-bind="price" data-size="${esc(s.label)}">${money(s.price)}</span>`
```

(FakePainter has a local `esc`/`escapeHtml` — reuse whatever it names it; add one mirroring
`src/vocabularies/shared/binding.ts:24` if absent.)

- [ ] **Step 4: Run the full hermetic suite**

Run: `npm test`
Expected: PASS — e2e fixtures with sized items now emit tagged spans and the new QA rule passes on
FakePainter output. If an e2e fixture fails, the fix is in the fake/fixture markup (tagged spans),
never in loosening the check.

- [ ] **Step 5: Commit**

```bash
git add src/qa src/config/layouts.ts src/adapters/openrouter/painter.ts src/testing/fakes/painter.ts
git commit -m "feat(qa): per-size price binding verified per data-size tag; free-paint matrix + fakes stamp it"
```

---

### Task A4: Name binding — `data-bind="name"` across both paint paths, config-enforced

The rename overlay (spec §4) needs a reliable name target. Add a shared `bindName` helper, stamp it
in all vocabularies + the free-paint contract + FakePainter, and enforce it via
`qa.requiredBindings` default `["price", "name"]`. Matrix-represented items are exempt (their name
is the row label — the skeleton's label div gains the span instead, checked via the row ancestor).

**Files:**
- Modify: `src/vocabularies/shared/binding.ts` (add `bindName`)
- Modify: `src/vocabularies/shared/contract.testkit.ts` (extend the renderSection/flow contract tests)
- Modify: `src/vocabularies/{bazaar,blockframe,bold-poster}/index.ts` — wrap the item-name text
  node in `bindName`
- Modify: `src/vocabularies/dhaba/index.ts` — same, via its private helpers
- Modify: `src/config/qa.ts:158` — `.default(["price"])` → `.default(["price", "name"])`
- Modify: `src/config/config.test.ts:14` — expectation becomes `["price", "name"]`
- Modify: `src/qa/structural-checks.ts:150-167` — name-specific rules (matrix exemption + non-empty)
- Modify: `src/config/layouts.ts` MATRIX_SKELETON — row label div becomes
  `<div><span data-bind="name">Chicken Dum</span></div>`
- Modify: `src/adapters/openrouter/painter.ts:71` — contract sentence gains the name span
- Modify: `src/testing/fakes/painter.ts` — item name wrapped in `<span data-bind="name">`
- Test: `src/qa/structural-checks.test.ts`

**Interfaces:**
- Consumes: `esc` from the shared kit.
- Produces: `bindName(name: string, style: string): string` →
  `<span data-bind="name" style="...">escaped name</span>`. Overlay contract: every PASSING bake
  has, per item, `[data-item-id] [data-bind="name"]` with non-empty text — OR the item sits in a
  `[data-matrix-cell]` whose ancestor `[data-matrix-row]` contains the name span.

- [ ] **Step 1: Write the failing tests**

`src/vocabularies/shared/binding.test.ts`:

```ts
it("bindName escapes and tags the item name", () => {
  expect(bindName('Chik "65"', "s")).toBe(
    '<span data-bind="name" style="s">Chik &quot;65&quot;</span>',
  );
});
```

`contract.testkit.ts` — inside the existing "renderSection stamps data-item-id…" test add:

```ts
const nameBinds = [...html.matchAll(/data-bind="name"[^>]*>([^<]*)</g)];
expect(nameBinds.length).toBeGreaterThanOrEqual(6);
```

and in the "flow pieces" test: `expect(row).toContain('data-bind="name"');`

`src/qa/structural-checks.test.ts`:

```ts
it("flags an item missing its data-bind=name hook", () => {
  const html = `<div data-item-id="n1"><b>Dosa</b>
    <span data-bind="price">$5.00</span></div>`;
  const findings = runCheckBindings(html, {
    items: [{ id: "n1", name: "Dosa", available: true, price: 5 }],
    plannedIds: ["n1"], requiredBindings: ["price", "name"],
  });
  expect(findings.map((f) => f.kind)).toContain("binding-hook-missing");
});

it("accepts a matrix item whose name lives on the row label", () => {
  const html = `<div data-matrix><div data-matrix-row="Chicken Dum">
    <div><span data-bind="name">Chicken Dum</span></div>
    <div data-matrix-cell="Biryani" data-item-id="m1" data-available="true">
      <span data-bind="price" data-size="Biryani">$9.00</span></div></div></div>`;
  const findings = runCheckBindings(html, {
    items: [{ id: "m1", name: "Chicken Dum Biryani", available: true, price: 9 }],
    plannedIds: ["m1"], requiredBindings: ["price", "name"],
  });
  expect(findings).toEqual([]);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run src/vocabularies/shared src/qa/structural-checks.test.ts`
Expected: FAIL (bindName missing; name-hook rule missing; matrix exemption missing).

- [ ] **Step 3: Implement**

Shared kit:

```ts
/** The item-name element carrying the engine's `data-bind="name"` marker (rename patch target). */
export const bindName = (name: string, style: string): string =>
  `<span data-bind="name" style="${style}">${esc(name)}</span>`;
```

`checkBindings` name rule — in the `for (const binding of ctx.qa.requiredBindings)` loop, before
the generic hook query:

```ts
if (binding === "name") {
  const inMatrixCell = node.getAttribute("data-matrix-cell") !== null ||
    node.closest?.("[data-matrix-cell]") !== null;
  const scope = inMatrixCell ? (node.closest("[data-matrix-row]") ?? node) : node;
  const hook = scope.querySelector('[data-bind="name"]');
  if (hook === null || hook.text.trim() === "") {
    findings.push(
      makeFinding({
        kind: FindingKind.BindingHookMissing,
        source: "deterministic",
        severity: "critical",
        tag: "content",
        itemId: id,
        message: `Item "${id}" is missing a non-empty data-bind="name" hook (patcher contract).`,
        data: { binding },
      }),
    );
  }
  continue;
}
```

(node-html-parser's HTMLElement has `closest`; if the version in use lacks it, walk `parentNode`
until `data-matrix-row` — keep the same semantics. NO text-equality check against `item.name`:
themes may legitimately truncate captions; the hook must exist and be non-empty, that's all.)

Vocabularies: wrap each row/lead/flow-row/caption *primary name text* in
`bindName(item.name, <existing style>)` (bazaar/blockframe/bold-poster import it; dhaba adds a
private copy identical to the shared body). The contract test drives out every miss.

Config default + config test; MATRIX_SKELETON label span; painter.ts:71 sentence becomes:

```
Every menu item element MUST have data-item-id="<id>" and data-available, its name in a
<span data-bind="name">, and every dynamic price in a <span data-bind="price"> (sized items: one
per size with data-size="<size label>"). In a matrix, the row-label div carries the name span.
```

FakePainter: wrap its item-name emission in `<span data-bind="name">…</span>`.

- [ ] **Step 4: Run the full suite**

Run: `npm test`
Expected: PASS. Failures here are fixture/fake markup gaps (add the name span), never check
loosening.

- [ ] **Step 5: Commit**

```bash
git add src/vocabularies src/config src/qa src/adapters/openrouter/painter.ts src/testing/fakes/painter.ts
git commit -m "feat(qa,vocabularies): data-bind=name on every item via requiredBindings — rename overlay target (spec §4)"
```

---

### Task A5: Pin `--color-sold` in packaged CSS + composed patch-contract audit test

Two small pins, one task. (a) The overlay styles strikes with `var(--color-sold)`; today's packaged
output happens to define it — pin it with a test so a theme/packager change can't silently drop it.
(b) Spec §9.3: an explicit test that composed output carries the full patch surface end-to-end
(id + name + price spans reachable in a PACKAGED board), using the fake engine.

**Files:**
- Test: `src/adapters/tailwind/packager.test.ts` (the existing real-compile test file; if it lives
  under a different name, `grep -rln "compile" src/adapters/tailwind --include="*.test.ts"`)
- Test: `src/pipeline/engine.test.ts` (extend with one e2e assertion block)

**Interfaces:**
- Consumes: `createFakeEngine` (`src/testing/fakes/`), `fixtures` from `src/testing/`.
- Produces: guarantees menu-cast may rely on: packaged HTML defines `--color-sold`; every planned
  item id resolves to `[data-item-id]` with name + price hooks in the SHIPPED artifact.

- [ ] **Step 1: Write the failing/pinning tests**

Packager test (uses the file's existing compile harness/fixtures — same pattern as its current
assertions):

```ts
it("defines --color-sold in the packaged stylesheet for every bundled theme", async () => {
  for (const presetId of ["dhaba", "botanical", "bubblegum", "bazaar", "blockframe", "bold-poster"]) {
    const html = await packageFixture(presetId); // the file's existing helper for a minimal board
    expect(html, presetId).toContain("--color-sold");
  }
});
```

Engine e2e (in `engine.test.ts`, alongside the existing happy-path scenario, reusing its fake
wiring):

```ts
it("ships the full patch surface: id, name hook, price hook per planned item", async () => {
  const engine = createFakeEngine(); // same construction the happy-path test uses
  const out = await engine.generate(fixtures.generateInput());
  for (const screen of out.screens) {
    const root = parse(screen.html);
    for (const id of screen.itemIds) {
      const node = root.querySelector(`[data-item-id="${id}"]`);
      expect(node, id).not.toBeNull();
      const scope = node!.closest("[data-matrix-row]") ?? node!;
      expect(scope.querySelector('[data-bind="name"]'), id).not.toBeNull();
    }
  }
});
```

(`parse` from node-html-parser, already a dependency of the QA layer. Adapt
`createFakeEngine()`/`fixtures.generateInput()` to the file's real helper names — grep the
happy-path test at the top of `engine.test.ts` and mirror it exactly.)

- [ ] **Step 2: Run to verify status**

Run: `npx vitest run src/adapters/tailwind src/pipeline/engine.test.ts`
Expected: the packager test PASSES already (pin) unless a theme misses the token — then fix that
theme's JSON `tokens` block by adding a `sold` colour consistent with its palette. The engine test
PASSES given A4 (if it fails, the gap is in FakePainter/fixture markup — fix there).

- [ ] **Step 3: Commit**

```bash
git add src/adapters/tailwind/*.test.ts src/pipeline/engine.test.ts themes
git commit -m "test(qa,packager): pin --color-sold in packaged CSS and the shipped patch surface per item"
```

---

### Task A6: Single-screen invocation — sliced pinned plan, verified + documented

The worker re-bakes one screen by slicing the stored plan (spec §5). Verify the engine supports it
exactly as the worker will call it, and pin the failure mode for a wrong item subset.

**Files:**
- Test: `src/pipeline/engine.test.ts`

**Interfaces:**
- Consumes: `createFakeEngine` accepting `plan` override (StaticPlanner path), fixtures.
- Produces: the verified calling convention Plan B's worker uses:
  `generate({ items: <only the sliced screen's items>, brief, constraints: { ...c, screens: 1 }, plan: { screens: [<that one PlanScreen>] } })`
  → exactly one screen out, `screen.id` preserved, all planned items bound. And: passing items NOT
  covered by the sliced plan → engine throws its coverage error (`PlanCoverageError` — assert via
  the error `code` the engine's errors module exports for plan coverage; grep
  `src/domain/errors.ts` for the coverage/plan error class name and use it verbatim).

- [ ] **Step 1: Write the failing tests**

```ts
describe("single-screen re-bake via sliced static plan (menu-cast worker contract)", () => {
  it("renders exactly the sliced screen with its items", async () => {
    const full = fixtures.twoScreenPlan(); // if no such fixture exists, build a ThinPlan literal
    const slice = full.screens[1]!;        // with 2 screens over the sample menu's categories
    const items = fixtures.sampleMenu().filter((i) =>
      slice.sections.some((s) => s.items.includes(i.id)));
    const engine = createFakeEngine({ plan: { screens: [slice] } }); // match createFakeEngine's real option shape
    const out = await engine.generate({
      items,
      brief: fixtures.brief(),
      constraints: { ...fixtures.constraints(), screens: 1 },
    });
    expect(out.screens).toHaveLength(1);
    expect(out.screens[0]!.id).toBe(slice.id);
    const bound = new Set(out.screens[0]!.itemIds);
    for (const s of slice.sections) for (const id of s.items) expect(bound.has(id), id).toBe(true);
  });

  it("throws the coverage error when items outside the sliced plan are passed", async () => {
    const full = fixtures.twoScreenPlan();
    const slice = full.screens[1]!;
    const engine = createFakeEngine({ plan: { screens: [slice] } });
    await expect(
      engine.generate({
        items: fixtures.sampleMenu(), // the FULL menu — screen-0's items are unplaced
        brief: fixtures.brief(),
        constraints: { ...fixtures.constraints(), screens: 1 },
      }),
    ).rejects.toMatchObject({ code: COVERAGE_ERROR_CODE }); // the exact code from src/domain/errors.ts
  });
});
```

- [ ] **Step 2: Run**

Run: `npx vitest run src/pipeline/engine.test.ts -t "single-screen"`
Expected: first test PASSES if the engine already supports slicing (likely); the second documents
the coverage contract. If the FIRST test FAILS (e.g. static-plan validation rejects a 1-screen
slice, or coverage asserts against non-plan items differently), that failure is the finding —
fix in `src/planning/coverage.ts` / `src/pipeline/engine.ts:206` area WITHOUT weakening the
100%-coverage guarantee for the multi-screen path, then re-run `npm test`.

- [ ] **Step 3: Commit**

```bash
git add src/pipeline/engine.test.ts
git commit -m "test(engine): pin the single-screen sliced-plan calling convention for the menu-cast bake worker"
```

---

### Task A7: Full verify + spec addendum

- [ ] **Step 1: Run the gate**

Run: `npm run verify`
Expected: prettier, eslint, tsc, vitest all green.

- [ ] **Step 2: Append the drift addendum to the spec**

At the bottom of `docs/superpowers/specs/2026-07-13-menucast-integration-design.md` add:

```markdown
## Addendum (2026-07-16, Plan A)

- Since approval, `blockframe` and `bold-poster` gained composition vocabularies — three composed
  themes now exist. The launch default stays `dhaba`; the restaurant theme field may offer any
  composed theme without cost/reliability change.
- Plan A added one feature beyond §9: `VocabItem.sizes` + per-size tagged price spans on composed
  boards (sized items previously rendered as "MP" there), because sized items are core menu-cast
  content. QA now verifies per-size tags (`data-size`), which §4's overlay may rely on.
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/specs/2026-07-13-menucast-integration-design.md
git commit -m "docs(spec): addendum — composed-theme expansion + sized-price contract from Plan A"
```
