# Brand Logo / Header Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Accept optional per-run brand content (logo + optional name/tagline) and render it as a header band on every screen, with the logo source supporting a URL, a local filesystem path, or a `data:` URI.

**Architecture:** A logo `src` (URL / fs path / `data:`) is resolved to a `data:` URI at the Node composition root (`createNodeEngine`) so the pure core stays hermetic (no network/fs). The resolved brand rides inside `state.input` end-to-end. The painter emits an `<img data-brand-logo>` placeholder with NO src (mirroring item photos); the packager injects the real data-URI at package time. A structural QA check guarantees the logo actually renders. See spec: `docs/superpowers/specs/2026-07-01-brand-logo-header-design.md` (decision **D18**).

**Tech Stack:** TypeScript (ESM, strict), Zod 4, node-html-parser, Vitest. Node ≥18 (`fetch`/`Buffer`/`fs/promises`).

## Global Constraints

- **Zod 4:** use `.optional()` on additive fields; never `.default({})` (use `.prefault({})` if a nested default is needed).
- **`tsconfig` strict:** `verbatimModuleSyntax` (use `import type` for types), `exactOptionalPropertyTypes` (never pass `{ field: undefined }` — spread conditionally: `...(x !== undefined ? { field: x } : {})`), `noPropertyAccessFromIndexSignature` (bracket-access index signatures).
- **Hermetic boundary (eslint-enforced):** only `src/node.ts` and `src/adapters/**` may touch network/fs or import optional peers. Brand logo resolution (fs/`fetch`) lives ONLY in `src/adapters/**`.
- **Backward compatible:** `brand` is optional everywhere; runs without it must behave identically. Existing fakes/adapters compile unchanged.
- **Gate:** `npm run verify` (prettier → eslint → tsc → vitest) must pass at the end. Default `vitest run` includes `src/**/*.test.ts` (only `*.live.test.ts` is gated), so every test below runs hermetically with no network/browser/key.
- **Commit after every task.**

---

### Task 1: Brand input schema, types, and `BrandAssetError` (domain layer)

**Files:**
- Modify: `src/domain/schemas.ts` (add brand schemas; add `brand` to `generateInputSchema`)
- Modify: `src/domain/types.ts` (derive `BrandLogo` / `BrandInput`)
- Modify: `src/domain/errors.ts` (add `"BRAND_ASSET"` code + `BrandAssetError`)
- Test: `src/domain/domain.test.ts` (append)

**Interfaces:**
- Produces: `brandLogoSchema`, `brandInputSchema` (Zod); `BrandLogo = { src: string; alt?: string }`, `BrandInput = { logo?: BrandLogo; name?: string; tagline?: string }`; `generateInputSchema` now has optional `brand: BrandInput`; `BrandAssetError extends ContentEngineError` with `code === "BRAND_ASSET"`.

- [ ] **Step 1: Write failing tests** — append to `src/domain/domain.test.ts`:

```ts
import { generateInputSchema, brandInputSchema } from "./schemas";
import { BrandAssetError } from "./errors";

describe("brand input", () => {
  const base = {
    items: [{ id: "p1", name: "Pizza", category: "Mains", price: 9 }],
    brief: { presetId: "botanical" },
  };

  it("accepts a logo with name and tagline", () => {
    const parsed = generateInputSchema.parse({
      ...base,
      brand: { logo: { src: "data:image/png;base64,AAAA", alt: "Acme" }, name: "Acme", tagline: "Fresh" },
    });
    expect(parsed.brand?.name).toBe("Acme");
    expect(parsed.brand?.logo?.src).toBe("data:image/png;base64,AAAA");
  });

  it("accepts input with no brand (backward compatible)", () => {
    expect(generateInputSchema.parse(base).brand).toBeUndefined();
  });

  it("rejects an empty logo src", () => {
    expect(() => brandInputSchema.parse({ logo: { src: "" } })).toThrow();
  });

  it("BrandAssetError carries the stable code", () => {
    const err = new BrandAssetError("nope");
    expect(err.code).toBe("BRAND_ASSET");
    expect(err).toBeInstanceOf(BrandAssetError);
  });
});
```

> Note: `category`/`price` field names above must match the real `canonicalItemSchema`. If `npm test` reports the fixture shape is wrong, replace `base.items` with `fixtures.input.items` (`import { fixtures } from "../testing/fixtures/index";`) — the point of the test is the `brand` field, not item shape.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/domain/domain.test.ts -t "brand input"`
Expected: FAIL (`brandInputSchema` / `BrandAssetError` not exported).

- [ ] **Step 3: Add the schemas** — in `src/domain/schemas.ts`, insert immediately BEFORE `export const generateInputSchema`:

```ts
/* ------------------------------------------------------------------ brand (D18) */

/** A brand logo source: a data: URI, an http(s) URL, or a local fs path. The Node composition
 * root resolves URL/path to a data-URI before the pure core sees it (hermetic boundary). */
export const brandLogoSchema = z.object({
  src: z.string().min(1),
  /** Accessibility / fallback text for the logo image. */
  alt: z.string().optional(),
});

/** Optional per-run brand content, rendered as a header band on every screen. Brand *colour*
 * is intentionally NOT here — `brief.palette` token overrides already cover it (D18). */
export const brandInputSchema = z.object({
  logo: brandLogoSchema.optional(),
  name: z.string().min(1).optional(),
  tagline: z.string().min(1).optional(),
});
```

Then add ONE line inside the `generateInputSchema` object (after `plan: thinPlanSchema.optional(),`):

```ts
  /** Optional brand content (logo + name/tagline) rendered as a header band (D18). */
  brand: brandInputSchema.optional(),
```

- [ ] **Step 4: Add the types** — in `src/domain/types.ts`, add `brandLogoSchema` and `brandInputSchema` to the existing `import type { … } from "./schemas"` list, then add near `ThemeBrief`:

```ts
export type BrandLogo = z.infer<typeof brandLogoSchema>;
export type BrandInput = z.infer<typeof brandInputSchema>;
```

- [ ] **Step 5: Add the error** — in `src/domain/errors.ts`, add `| "BRAND_ASSET"` to the `ContentEngineErrorCode` union (e.g. after `"CONFIG"`), and add this class near the other subclasses:

```ts
/** A brand asset (logo) could not be read/fetched from its source (fs path or URL). Unlike item
 * photos (which degrade to a placeholder), a logo the caller explicitly pointed at fails loud. */
export class BrandAssetError extends ContentEngineError {
  constructor(message: string, options?: ContentEngineErrorOptions) {
    super("BRAND_ASSET", message, options);
  }
}
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run src/domain/domain.test.ts -t "brand input"`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/domain/schemas.ts src/domain/types.ts src/domain/errors.ts src/domain/domain.test.ts
git commit -m "feat: brand input schema, types, and BrandAssetError (D18)"
```

---

### Task 2: Extract shared MIME helpers from the image fetcher

**Files:**
- Create: `src/adapters/image/mime.ts`
- Modify: `src/adapters/image/image-fetcher.ts` (import from `./mime`, delete local copies)
- Test: `src/adapters/image/mime.test.ts`

**Interfaces:**
- Produces: `sniffMime(buffer: Buffer): string | null`, `mimeFor(contentType: string | null, buffer: Buffer): string | null`, `mimeForPath(path: string, buffer: Buffer): string | null`.

**Why:** the resolver in Task 3 needs the same magic-byte sniffing the fetcher already has (currently private). Extract to one module so both share it (DRY), plus an extension-based `mimeForPath` for local files.

- [ ] **Step 1: Write failing test** — `src/adapters/image/mime.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/adapters/image/mime.test.ts`
Expected: FAIL (`./mime` not found).

- [ ] **Step 3: Create `src/adapters/image/mime.ts`** (move the existing `sniffMime`/`mimeFor` bodies verbatim from `image-fetcher.ts`, add `mimeForPath`):

```ts
/** Shared image MIME detection for the Node image adapters (fetcher + brand asset resolver). */

/** Trust the server Content-Type when it's a real image type; otherwise sniff magic bytes. */
export function mimeFor(contentType: string | null, buffer: Buffer): string | null {
  const declared = (contentType ?? "").split(";")[0]?.trim().toLowerCase();
  if (declared && declared.startsWith("image/")) return declared;
  return sniffMime(buffer);
}

/** Resolve a local file's MIME by extension first, then fall back to magic-byte sniffing. */
export function mimeForPath(path: string, buffer: Buffer): string | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  const byExt: Record<string, string> = {
    png: "image/png",
    jpg: "image/jpeg",
    jpeg: "image/jpeg",
    gif: "image/gif",
    webp: "image/webp",
    svg: "image/svg+xml",
  };
  return byExt[ext] ?? sniffMime(buffer);
}

export function sniffMime(b: Buffer): string | null {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47)
    return "image/png";
  if (b.length >= 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x38)
    return "image/gif";
  if (
    b.length >= 12 &&
    b[0] === 0x52 &&
    b[1] === 0x49 &&
    b[2] === 0x46 &&
    b[3] === 0x46 &&
    b[8] === 0x57 &&
    b[9] === 0x45 &&
    b[10] === 0x42 &&
    b[11] === 0x50
  )
    return "image/webp";
  const head = b.subarray(0, 256).toString("utf8").trimStart().toLowerCase();
  if (head.startsWith("<?xml") || head.startsWith("<svg")) return "image/svg+xml";
  return null;
}
```

- [ ] **Step 4: Update the fetcher** — in `src/adapters/image/image-fetcher.ts`: delete the local `mimeFor` and `sniffMime` function definitions (bottom of file) and add at the top:

```ts
import { mimeFor } from "./mime";
```

- [ ] **Step 5: Run tests to verify both pass**

Run: `npx vitest run src/adapters/image/mime.test.ts src/adapters/image/image-fetcher.test.ts`
Expected: PASS (fetcher behavior unchanged, new mime tests green).

- [ ] **Step 6: Commit**

```bash
git add src/adapters/image/mime.ts src/adapters/image/image-fetcher.ts src/adapters/image/mime.test.ts
git commit -m "refactor: extract shared MIME helpers for image adapters"
```

---

### Task 3: `resolveAssetToDataUri` + `normalizeBrandLogo` (adapter)

**Files:**
- Create: `src/adapters/image/asset-resolver.ts`
- Test: `src/adapters/image/asset-resolver.test.ts`

**Interfaces:**
- Consumes: `BrandAssetError` (Task 1), `mimeFor`/`mimeForPath` (Task 2).
- Produces: `resolveAssetToDataUri(src: string): Promise<string>`, `normalizeBrandLogo(input: unknown): Promise<unknown>`.

- [ ] **Step 1: Write failing tests** — `src/adapters/image/asset-resolver.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BrandAssetError } from "../../domain/errors";
import { normalizeBrandLogo, resolveAssetToDataUri } from "./asset-resolver";

const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("resolveAssetToDataUri", () => {
  it("passes a data: URI through unchanged", async () => {
    const uri = "data:image/png;base64,AAAA";
    expect(await resolveAssetToDataUri(uri)).toBe(uri);
  });

  it("reads a local file into a data-URI", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brand-"));
    const file = join(dir, "logo.png");
    writeFileSync(file, PNG_BYTES);
    const uri = await resolveAssetToDataUri(file);
    expect(uri.startsWith("data:image/png;base64,")).toBe(true);
    expect(uri).toBe(`data:image/png;base64,${PNG_BYTES.toString("base64")}`);
  });

  it("throws BrandAssetError for a missing file", async () => {
    await expect(resolveAssetToDataUri("/no/such/logo.png")).rejects.toBeInstanceOf(BrandAssetError);
  });
});

describe("normalizeBrandLogo", () => {
  it("leaves input without a brand logo untouched", async () => {
    const input = { items: [], brief: { presetId: "x" } };
    expect(await normalizeBrandLogo(input)).toBe(input);
  });

  it("resolves brand.logo.src to a data-URI, preserving siblings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "brand-"));
    const file = join(dir, "logo.png");
    writeFileSync(file, PNG_BYTES);
    const out = (await normalizeBrandLogo({
      items: [],
      brief: { presetId: "x" },
      brand: { logo: { src: file, alt: "Acme" }, name: "Acme" },
    })) as { brand: { logo: { src: string; alt: string }; name: string } };
    expect(out.brand.logo.src.startsWith("data:image/png;base64,")).toBe(true);
    expect(out.brand.logo.alt).toBe("Acme");
    expect(out.brand.name).toBe("Acme");
  });

  it("leaves an already-data-URI logo unchanged", async () => {
    const input = { brand: { logo: { src: "data:image/png;base64,AAAA" } } };
    const out = (await normalizeBrandLogo(input)) as typeof input;
    expect(out.brand.logo.src).toBe("data:image/png;base64,AAAA");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/adapters/image/asset-resolver.test.ts`
Expected: FAIL (`./asset-resolver` not found).

- [ ] **Step 3: Create `src/adapters/image/asset-resolver.ts`**:

```ts
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { BrandAssetError } from "../../domain/errors";
import { mimeFor, mimeForPath } from "./mime";

/**
 * Resolve a brand asset `src` to an offline-safe `data:` URI so the pure core never sees a
 * network/fs reference (hermetic boundary). Handles three source kinds:
 *   - `data:`            → returned unchanged
 *   - `http(s)://`       → fetched, MIME-detected, base64-encoded
 *   - `file://` or path  → read from disk, MIME-by-extension (then sniff), base64-encoded
 * A source that cannot be read/fetched throws {@link BrandAssetError} (fail loud — a logo the
 * caller explicitly pointed at is a real misconfiguration, unlike a flaky item-photo host).
 */
export async function resolveAssetToDataUri(src: string): Promise<string> {
  const trimmed = src.trim();
  if (trimmed.startsWith("data:")) return trimmed;

  if (/^https?:\/\//i.test(trimmed)) {
    let response: Response;
    try {
      response = await globalThis.fetch(trimmed);
    } catch (cause) {
      throw new BrandAssetError(`brand logo could not be fetched from "${src}".`, { cause });
    }
    if (!response.ok) {
      throw new BrandAssetError(`brand logo fetch failed (HTTP ${response.status}) for "${src}".`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const mime = mimeFor(response.headers.get("content-type"), buffer);
    if (!mime) throw new BrandAssetError(`brand logo at "${src}" is not a recognised image type.`);
    return `data:${mime};base64,${buffer.toString("base64")}`;
  }

  const path = trimmed.startsWith("file://") ? fileURLToPath(trimmed) : trimmed;
  let buffer: Buffer;
  try {
    buffer = await readFile(path);
  } catch (cause) {
    throw new BrandAssetError(`brand logo could not be read from "${src}".`, { cause });
  }
  const mime = mimeForPath(path, buffer);
  if (!mime) throw new BrandAssetError(`brand logo at "${src}" is not a recognised image type.`);
  return `data:${mime};base64,${buffer.toString("base64")}`;
}

/**
 * Input normalization for the Node composition root: if `input.brand.logo.src` is present and not
 * already a `data:` URI, resolve it and return a shallow-rebuilt input carrying the data-URI.
 * Any other input is returned unchanged. Full validation still happens inside the pure engine.
 */
export async function normalizeBrandLogo(input: unknown): Promise<unknown> {
  if (typeof input !== "object" || input === null) return input;
  const brand = (input as { brand?: unknown }).brand;
  if (typeof brand !== "object" || brand === null) return input;
  const logo = (brand as { logo?: unknown }).logo;
  if (typeof logo !== "object" || logo === null) return input;
  const src = (logo as { src?: unknown }).src;
  if (typeof src !== "string" || src.trim() === "") return input;

  const dataUri = await resolveAssetToDataUri(src);
  return {
    ...(input as Record<string, unknown>),
    brand: {
      ...(brand as Record<string, unknown>),
      logo: { ...(logo as Record<string, unknown>), src: dataUri },
    },
  };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/adapters/image/asset-resolver.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/image/asset-resolver.ts src/adapters/image/asset-resolver.test.ts
git commit -m "feat: resolve brand logo (data:/http/fs) to a data-URI"
```

---

### Task 4: Wire `normalizeBrandLogo` into `createNodeEngine`

**Files:**
- Modify: `src/adapters/node-engine.ts`
- Test: `src/adapters/node-engine.test.ts` (create)

**Interfaces:**
- Consumes: `normalizeBrandLogo` (Task 3), `BrandAssetError` (Task 1), the `ContentEngine` interface (`generate`, `plan`).
- Produces: `createNodeEngine(...)` returns a `ContentEngine` whose `generate` resolves the brand logo before delegating; `plan` delegates unchanged.

- [ ] **Step 1: Write failing test** — `src/adapters/node-engine.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import { BrandAssetError } from "../domain/errors";
import { createNodeEngine } from "./node-engine";

/**
 * Hermetic: no network is reached because brand-logo resolution runs BEFORE the pure engine, and
 * a bogus logo path throws first. Proves createNodeEngine wraps generate with normalizeBrandLogo.
 */
describe("createNodeEngine — brand logo resolution", () => {
  it("resolves the brand logo before the pipeline, failing loud on a bad path", async () => {
    const engine = createNodeEngine({ openRouterApiKey: "test-key" });
    await expect(
      engine.generate({
        items: [{ id: "p1", name: "Pizza", category: "Mains", price: 9 }],
        brief: { presetId: "botanical" },
        brand: { logo: { src: "/no/such/logo.png" } },
      }),
    ).rejects.toBeInstanceOf(BrandAssetError);
  });
});
```

> If `items` shape errors, import `fixtures` and use `fixtures.input.items` (see Task 1 note). The assertion under test is the `BrandAssetError`, which is thrown before any item validation.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/adapters/node-engine.test.ts`
Expected: FAIL (today `generate` does not resolve the logo, so a different error — or none — is thrown).

- [ ] **Step 3: Wire the wrapper** — in `src/adapters/node-engine.ts`:

Add imports:
```ts
import type { GenerateOutput } from "../domain/types";
import { normalizeBrandLogo } from "./image/asset-resolver";
```
(`ThinPlan` is already imported.)

Replace the final `return createEngine(ports, options.config);` with:

```ts
  const engine = createEngine(ports, options.config);
  // Resolve any brand logo (URL / fs path) to a data-URI before the pure, hermetic core runs.
  // `plan()` doesn't touch brand, so it delegates unchanged (no needless fetch/read).
  return {
    async generate(input: unknown): Promise<GenerateOutput> {
      return engine.generate(await normalizeBrandLogo(input));
    },
    plan(input: unknown): Promise<ThinPlan> {
      return engine.plan(input);
    },
  };
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/adapters/node-engine.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/adapters/node-engine.ts src/adapters/node-engine.test.ts
git commit -m "feat: resolve brand logo at the Node composition root (D18)"
```

---

### Task 5: Thread brand into `PaintRequest`, paint node, and painter prompt

**Files:**
- Modify: `src/ports/painter.ts` (add `brand` to `PaintRequest`)
- Modify: `src/pipeline/nodes/index.ts` (`paintNode` passes `brand`)
- Modify: `src/adapters/openrouter/painter.ts` (`describeRequest` emits brand lines; export `brandUserLines`)
- Test: `src/adapters/openrouter/painter.test.ts` (append)

**Interfaces:**
- Consumes: `BrandInput` (Task 1).
- Produces: `PaintRequest.brand?: BrandInput`; exported `brandUserLines(brand: BrandInput): string[]`.

- [ ] **Step 1: Write failing test** — append to `src/adapters/openrouter/painter.test.ts`:

```ts
import { brandUserLines } from "./painter";

describe("brandUserLines", () => {
  it("instructs the no-src placeholder and includes name/tagline/alt", () => {
    const lines = brandUserLines({
      logo: { src: "data:image/png;base64,AAAA", alt: "Acme logo" },
      name: "Acme Diner",
      tagline: "Fresh daily",
    }).join("\n");
    expect(lines).toContain("data-brand-logo");
    expect(lines).toContain("NO src");
    expect(lines).toContain("Acme Diner");
    expect(lines).toContain("Fresh daily");
    expect(lines).toContain("Acme logo");
  });

  it("omits absent fields", () => {
    const lines = brandUserLines({ name: "Acme" }).join("\n");
    expect(lines).toContain("Acme");
    expect(lines).not.toContain("Tagline");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/adapters/openrouter/painter.test.ts -t brandUserLines`
Expected: FAIL (`brandUserLines` not exported).

- [ ] **Step 3: Add `brand` to `PaintRequest`** — in `src/ports/painter.ts`, add to the imports `BrandInput` and add a field to the `PaintRequest` interface:

```ts
  /** Optional brand content (logo + name/tagline). Present → the painter renders a header band;
   * the logo uses the `data-brand-logo` no-src placeholder scheme (packager inlines it). */
  brand?: BrandInput;
```

- [ ] **Step 4: Emit brand lines in the painter prompt** — in `src/adapters/openrouter/painter.ts`:

Add `BrandInput` to the domain type imports, then add this exported function above `describeRequest`:

```ts
/** The brand-header instruction block appended to the painter's user prompt when a run has brand
 * content. Uses the item-photo placeholder scheme so the large data-URI never passes through the
 * model (an LLM can't reproduce a long base64 blob reliably). */
export function brandUserLines(brand: BrandInput): string[] {
  const lines: string[] = [
    "BRAND HEADER — this run has brand content; render a header band at the TOP of the screen combining the brand with the screen title:",
    "- Place the logo as <img data-brand-logo> with NO src attribute — the engine inlines the real image at package time. NEVER put a URL in src.",
    "- Size the logo as a real header element (not a tiny thumbnail, not overpowering the menu), on a theme surface that suits it (transparent logos need an appropriate backing).",
  ];
  if (brand.logo?.alt !== undefined) lines.push(`- Logo alt text: ${JSON.stringify(brand.logo.alt)}`);
  if (brand.name !== undefined) lines.push(`- Brand name (render as text in the header): ${JSON.stringify(brand.name)}`);
  if (brand.tagline !== undefined) lines.push(`- Tagline (smaller text near the name): ${JSON.stringify(brand.tagline)}`);
  return lines;
}
```

Inside `describeRequest`, after the `imageSlot` block (before the `components` block), add:

```ts
  if (request.brand !== undefined) {
    lines.push(...brandUserLines(request.brand));
  }
```

- [ ] **Step 5: Pass brand from the paint node** — in `src/pipeline/nodes/index.ts`, in `paintNode`, add to the `ctx.ports.painter.paint({ … })` argument object (alongside the existing conditional spreads):

```ts
    ...(state.input.brand !== undefined ? { brand: state.input.brand } : {}),
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run src/adapters/openrouter/painter.test.ts -t brandUserLines`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/ports/painter.ts src/adapters/openrouter/painter.ts src/pipeline/nodes/index.ts src/adapters/openrouter/painter.test.ts
git commit -m "feat: thread brand into PaintRequest and painter prompt"
```

---

### Task 6: Inject the brand logo data-URI in the packagers

**Files:**
- Modify: `src/ports/packager.ts` (add `brandLogoDataUri` to `PackageRequest`)
- Modify: `src/pipeline/nodes/index.ts` (`packageNode` passes it)
- Modify: `src/adapters/tailwind/packager.ts` (`inlineBrandLogo`)
- Modify: `src/testing/fakes/packager.ts` (mirror injection)
- Test: `src/adapters/tailwind/packager.test.ts` (append)

**Interfaces:**
- Produces: `PackageRequest.brandLogoDataUri?: string`; both packagers fill `[data-brand-logo]` `src` with it (or the offline placeholder when absent).

- [ ] **Step 1: Write failing test** — append to `src/adapters/tailwind/packager.test.ts` (mirror the existing test's setup for building a `PackageRequest`; reuse whatever theme/items helper the file already defines):

```ts
it("inlines the brand logo data-URI into the [data-brand-logo] placeholder", async () => {
  const logo = "data:image/png;base64,AAAABBBB";
  const html = '<main><header><img data-brand-logo alt="Acme"></header></main>';
  const packaged = await new TailwindPackager().package({
    html,
    theme: /* the test file's theme fixture */ themeFixture,
    items: [],
    brandLogoDataUri: logo,
  });
  expect(packaged).toContain(`src="${logo}"`);
  expect(packaged).toContain("data-brand-logo");
});
```

> Use the exact `TailwindPackager` import and `themeFixture` name already present in `packager.test.ts`. If the file builds its theme inline, copy that construction here.

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/adapters/tailwind/packager.test.ts -t "brand logo"`
Expected: FAIL (`brandLogoDataUri` not accepted / placeholder not filled).

- [ ] **Step 3: Add the field** — in `src/ports/packager.ts`, add to `PackageRequest`:

```ts
  /** The resolved brand logo as a data-URI (already inlined by the Node root). The packager
   * fills the painter's `<img data-brand-logo>` placeholder with it, offline-safe (D18). */
  brandLogoDataUri?: string;
```

- [ ] **Step 4: Inject in TailwindPackager** — in `src/adapters/tailwind/packager.ts`, add the helper next to `inlineItemImages`:

```ts
/** Fill the painter's `<img data-brand-logo>` header placeholder (no src) with the resolved brand
 * logo data-URI, or the offline placeholder when no logo was provided (mirrors inlineItemImages). */
function inlineBrandLogo(root: HTMLElement, dataUri: string | undefined): void {
  for (const el of root.querySelectorAll("[data-brand-logo]")) {
    el.setAttribute("src", dataUri && dataUri.trim() !== "" ? dataUri : PLACEHOLDER_IMAGE_DATA_URI);
  }
}
```

And call it in `package()`, right after `inlineItemImages(root, request.items);`:

```ts
      inlineBrandLogo(root, request.brandLogoDataUri);
```

- [ ] **Step 5: Mirror in FakePackager** — in `src/testing/fakes/packager.ts`:

Add the same `inlineBrandLogo` helper (copy the body from Step 4). Change `FakePackager.package` to forward the logo, and thread it through `packageHtml`:

```ts
  package(request: PackageRequest): Promise<string> {
    return Promise.resolve(packageHtml(request.html, request.theme, request.items, request.brandLogoDataUri));
  }
```
```ts
function packageHtml(
  html: string,
  theme: ResolvedTheme,
  items: readonly CanonicalItem[],
  brandLogoDataUri?: string,
): string {
  const root = parse(html);
  inlineItemImages(root, items);
  inlineBrandLogo(root, brandLogoDataUri);
  // …unchanged document wrapping…
```

- [ ] **Step 6: Pass brand logo from the package node** — in `src/pipeline/nodes/index.ts`, in `packageNode`, add to the `ctx.ports.packager.package({ … })` argument object:

```ts
    ...(state.input.brand?.logo?.src !== undefined ? { brandLogoDataUri: state.input.brand.logo.src } : {}),
```

(By package time, `state.input.brand.logo.src` is the resolved data-URI — Task 4.)

- [ ] **Step 7: Run tests to verify pass**

Run: `npx vitest run src/adapters/tailwind/packager.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/ports/packager.ts src/adapters/tailwind/packager.ts src/testing/fakes/packager.ts src/pipeline/nodes/index.ts src/adapters/tailwind/packager.test.ts
git commit -m "feat: inline brand logo data-URI at package time"
```

---

### Task 7: `checkBrandBinding` structural QA check

**Files:**
- Modify: `src/qa/finding.ts` (add `FindingKind.BrandBinding`)
- Modify: `src/qa/structural-checks.ts` (add `brandLogoRequested` to `StructuralContext`; add `checkBrandBinding`; wire into `runStructuralChecks`)
- Modify: `src/pipeline/nodes/index.ts` (`deterministicQaNode` sets `brandLogoRequested`)
- Test: `src/qa/structural-checks.test.ts` (append)

**Interfaces:**
- Consumes: `StructuralContext`, `makeFinding`, `FindingKind`, the `DATA_URI` regex (already module-private in `structural-checks.ts`).
- Produces: `checkBrandBinding(root: HTMLElement, ctx: StructuralContext): QaFinding[]`; `StructuralContext.brandLogoRequested?: boolean`; `FindingKind.BrandBinding === "brand-binding"`.

- [ ] **Step 1: Write failing tests** — append to `src/qa/structural-checks.test.ts` (reuse the file's existing helper for building a `StructuralContext`; the fields below are the ones the check reads):

```ts
import { checkBrandBinding } from "./structural-checks";
import { parse } from "node-html-parser";

describe("checkBrandBinding", () => {
  const ctxWith = (extra: object) =>
    ({ planScreen: { id: "s", sections: [] }, items: [], theme: {}, qa: {}, tokenLint: {}, ...extra }) as never;

  it("no findings when no brand logo was requested", () => {
    const root = parse("<main></main>");
    expect(checkBrandBinding(root, ctxWith({ brandLogoRequested: false }))).toHaveLength(0);
  });

  it("flags a requested logo that was not rendered", () => {
    const root = parse("<main><h1>Menu</h1></main>");
    const found = checkBrandBinding(root, ctxWith({ brandLogoRequested: true }));
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("brand-binding");
  });

  it("passes when the placeholder carries an inlined data-URI src", () => {
    const root = parse('<main><img data-brand-logo src="data:image/png;base64,AAAA"></main>');
    expect(checkBrandBinding(root, ctxWith({ brandLogoRequested: true }))).toHaveLength(0);
  });

  it("flags a placeholder that leaked a non-inlined src", () => {
    const root = parse('<main><img data-brand-logo src="https://x/logo.png"></main>');
    const found = checkBrandBinding(root, ctxWith({ brandLogoRequested: true }));
    expect(found).toHaveLength(1);
    expect(found[0]!.kind).toBe("brand-binding");
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/qa/structural-checks.test.ts -t checkBrandBinding`
Expected: FAIL (`checkBrandBinding` not exported).

- [ ] **Step 3: Add the finding kind** — in `src/qa/finding.ts`, add to the `FindingKind` object:

```ts
  BrandBinding: "brand-binding",
```

- [ ] **Step 4: Add the context field + check** — in `src/qa/structural-checks.ts`:

Add to the `StructuralContext` interface:
```ts
  /** True when the run supplied a brand logo — enables the brand-binding check. */
  brandLogoRequested?: boolean;
```

Add the check (near `checkSelfContained`):
```ts
/** When a brand logo was requested, guarantee the painter actually rendered the header placeholder
 * and that it was inlined (no leaked remote/relative src). Mirrors binding-integrity for items. */
export function checkBrandBinding(root: HTMLElement, ctx: StructuralContext): QaFinding[] {
  if (ctx.brandLogoRequested !== true) return [];
  const logos = root.querySelectorAll("[data-brand-logo]");
  if (logos.length === 0) {
    return [
      makeFinding({
        kind: FindingKind.BrandBinding,
        source: "deterministic",
        severity: "major",
        tag: "structural",
        message: "Brand logo was provided but no <img data-brand-logo> header element was rendered.",
      }),
    ];
  }
  const findings: QaFinding[] = [];
  for (const el of logos) {
    const src = (el.getAttribute("src") ?? "").trim();
    if (src !== "" && !DATA_URI.test(src)) {
      findings.push(
        makeFinding({
          kind: FindingKind.BrandBinding,
          source: "deterministic",
          severity: "major",
          tag: "structural",
          message: `Brand logo carries a non-inlined src="${src}"; it must be a data-URI.`,
          data: { value: src },
        }),
      );
    }
  }
  return findings;
}
```

Wire it into `runStructuralChecks` (add to the returned array, after `checkSelfContained`):
```ts
    ...checkBrandBinding(pkgRoot, ctx),
```

- [ ] **Step 5: Set the flag from the QA node** — in `src/pipeline/nodes/index.ts`, in `deterministicQaNode`, add to the `runStructuralChecks({ … })` context object:

```ts
      brandLogoRequested: state.input.brand?.logo !== undefined,
```

- [ ] **Step 6: Run to verify it passes**

Run: `npx vitest run src/qa/structural-checks.test.ts -t checkBrandBinding`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/qa/finding.ts src/qa/structural-checks.ts src/pipeline/nodes/index.ts src/qa/structural-checks.test.ts
git commit -m "feat: brand-binding structural QA check"
```

---

### Task 8: FakePainter brand header + end-to-end test

**Files:**
- Modify: `src/testing/fakes/painter.ts` (emit `<img data-brand-logo>` header when `brand` present)
- Test: `src/pipeline/engine.test.ts` (append e2e case)

**Interfaces:**
- Consumes: `BrandInput`, `PaintRequest.brand` (Task 5), FakePackager injection (Task 6), `checkBrandBinding` (Task 7).

- [ ] **Step 1: Write failing e2e test** — append to `src/pipeline/engine.test.ts`:

```ts
it("renders and inlines a brand logo header when brand content is provided", async () => {
  const logo = "data:image/png;base64,AAAABBBBCCCC";
  const engine = createFakeEngine({ observations: [cleanObservation()] });
  const out = await engine.generate({
    ...fixtures.input,
    brand: { logo: { src: logo, alt: "Acme" }, name: "Acme Diner", tagline: "Fresh daily" },
  });
  const screen = out.screens[0]!;
  expect(screen.html).toContain("data-brand-logo");
  expect(screen.html).toContain(logo); // packager injected the resolved data-URI
  expect(screen.html).toContain("Acme Diner");
  expect(out.qaReport.screens[0]!.passed).toBe(true); // brand-binding check passes
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/pipeline/engine.test.ts -t "brand logo header"`
Expected: FAIL (FakePainter emits no `data-brand-logo`, so the injected data-URI/name are absent).

- [ ] **Step 3: Emit the header in FakePainter** — in `src/testing/fakes/painter.ts`:

Add `BrandInput` to the domain type imports. Change `paint`:
```ts
  paint(request: PaintRequest): Promise<string> {
    return Promise.resolve(renderScreen(request.planScreen, request.items, request.brand));
  }
```

Add the header renderer:
```ts
/** A minimal brand header band: an `<img data-brand-logo>` (NO src — the packager inlines it) plus
 * optional name/tagline text. Token classes only, no external refs — stays bindable + offline-safe. */
function renderBrandHeader(brand: BrandInput): string {
  const logo = brand.logo
    ? `<img data-brand-logo class="h-16" alt="${escapeHtml(brand.logo.alt ?? "brand logo")}">`
    : "";
  const name = brand.name ? `<span class="text-text">${escapeHtml(brand.name)}</span>` : "";
  const tagline = brand.tagline ? `<span class="text-muted">${escapeHtml(brand.tagline)}</span>` : "";
  return `<header class="brand-header flex items-center gap-3 p-4" data-motion="fade-in">${logo}${name}${tagline}</header>`;
}
```

Update `renderScreen`'s signature and output:
```ts
function renderScreen(
  screen: PlanScreen,
  items: readonly CanonicalItem[],
  brand?: BrandInput,
): string {
  // …unchanged section/carousel building…
  const header = brand !== undefined ? renderBrandHeader(brand) : "";
  return `<main class="screen grid gap-4 p-6">${header}${carousel}${sections}</main>`;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/pipeline/engine.test.ts -t "brand logo header"`
Expected: PASS.

- [ ] **Step 5: Full suite check**

Run: `npm test`
Expected: PASS (all suites, no regressions).

- [ ] **Step 6: Commit**

```bash
git add src/testing/fakes/painter.ts src/pipeline/engine.test.ts
git commit -m "test: e2e brand logo header (fakes)"
```

---

### Task 9: Documentation — D18, ARCHITECTURE, CLAUDE.md

**Files:**
- Modify: `DECISIONS.md` (add **D18**)
- Modify: `ARCHITECTURE.md` (brand input + resolve-at-root note)
- Modify: `CLAUDE.md` (one line on the new `brand` input)

- [ ] **Step 1: Add D18 to `DECISIONS.md`** (follow the file's existing D-entry format):

```markdown
## D18 — Brand content is a per-run input; logo resolves at the Node root, fails loud

Brand (logo + optional name/tagline) is an optional `brand` field on `GenerateInput`, not a theme
property — a venue's logo is theirs, independent of the chosen theme. Brand *colour* is excluded:
`brief.palette` token overrides already cover it. The logo `src` accepts a `data:` URI, an
`http(s)://` URL, or a local fs path (bare or `file://`), resolved to a data-URI at the Node
composition root (`createNodeEngine`) via `resolveAssetToDataUri`, so the pure core stays hermetic.
The painter emits `<img data-brand-logo>` with no src and the packager injects the data-URI at
package time (reusing the item-photo placeholder scheme). Unlike item photos (which degrade to a
placeholder), an unreadable logo throws `BrandAssetError` — a logo the caller explicitly pointed at
that can't be read is a real misconfiguration. A `brand-binding` structural check guarantees the
logo renders and stays inlined.
```

- [ ] **Step 2: Note it in `ARCHITECTURE.md`** — add a short paragraph where inputs / the composition root are described:

```markdown
**Brand content (D18).** `GenerateInput.brand` optionally carries a logo (+ name/tagline) rendered
as a header band on every screen. `createNodeEngine` resolves the logo `src` (URL / fs path / data:)
to a data-URI before the pure pipeline runs (`src/adapters/image/asset-resolver.ts`); the painter
emits an `<img data-brand-logo>` placeholder and the packager inlines it, so the artifact stays
offline-safe. The `checkBrandBinding` QA check guarantees the logo actually renders.
```

- [ ] **Step 3: One line in `CLAUDE.md`** — in the "What this is" / input description area:

```markdown
Optional `brand` input (`{ logo?: { src, alt? }, name?, tagline? }`) renders a logo header band on
every screen; the logo `src` may be a URL, a local fs path, or a data-URI (resolved to a data-URI at
the Node root — D18).
```

- [ ] **Step 4: Final verification**

Run: `npm run verify`
Expected: PASS (prettier, eslint, tsc, vitest all green).

- [ ] **Step 5: Commit**

```bash
git add DECISIONS.md ARCHITECTURE.md CLAUDE.md
git commit -m "docs: document brand logo/header feature (D18)"
```

---

## Self-Review

**Spec coverage:**
- Data model (logo + name + tagline; brand optional) → Task 1. ✅
- URL / fs path / data: resolution at Node root, hermetic → Tasks 3–4. ✅
- Fail-loud `BrandAssetError` → Tasks 1, 3, 4. ✅
- Header band on every screen, painter-on-rails → Task 5 (prompt) + Task 8 (fake). ✅
- Placeholder → packager injection (offline-safe) → Task 6. ✅
- Brand-binding structural check; contrast via existing tokens → Task 7. ✅
- Tests hermetic, in default suite → every task; full e2e Task 8. ✅
- Docs D18 → Task 9. ✅

**Type consistency:** `BrandInput`/`BrandLogo` (Task 1) are consumed by `PaintRequest.brand` (Task 5) and `brandUserLines` (Task 5) and FakePainter (Task 8). `brandLogoDataUri` naming is consistent across `PackageRequest`, `packageNode`, `TailwindPackager`, `FakePackager` (Task 6). `brandLogoRequested` consistent across `StructuralContext`, `checkBrandBinding`, `deterministicQaNode` (Task 7). `FindingKind.BrandBinding === "brand-binding"` matches the test assertions (Task 7). ✅

**Placeholder scan:** No TBD/TODO. The two "use the file's existing fixture" notes (Tasks 1, 6) point at concrete, already-present constructs rather than leaving code blank; every code step shows real code.

## Notes for the implementer

- The pure `createEngine`/`createFakeEngine` path does NOT run `normalizeBrandLogo` — that is Node-only. In the pure/fake path, pass `brand.logo.src` already as a `data:` URI (the e2e test in Task 8 does this). This is intentional (hermetic core).
- If item-shape assertions in a test fail, prefer `fixtures.input` (`src/testing/fixtures/index`) over hand-written items — the brand field is what's under test.
