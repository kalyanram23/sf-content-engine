/**
 * Renderer — composition JSON → one self-contained HTML string.
 *
 * The LLM's `Composition` carries only judgment (title, block order, groupings, collage picks). This
 * file owns everything deterministic: it validates the type/field pairing, GUARANTEES coverage (any
 * section the LLM forgot is appended — the same "LLM judges, code guarantees the bookkeeping"
 * contract as the real engine's coverage.ts), enforces photo-truth (captions come from menu data),
 * asks the fitter for sizes, and expands the closed vocabulary into the final board.
 */

import {
  masthead,
  polaroidCollage,
  priceList,
  sectionHeader,
  triBand,
  TOKENS,
  type Block,
  type Canvas,
  type Composition,
  type MenuItem,
  type ResolvedSection,
} from "./catalog";
import { collageBandHeight, fit, sectionColumns, type FitResult } from "./fitter";

export interface RenderContext {
  sections: ResolvedSection[];
  photoCandidates: MenuItem[];
  canvas: Canvas;
  tagline: string | null;
}

export interface RenderResult {
  html: string;
  finalBlocks: Block[];
  fit: FitResult;
  warnings: string[];
}

/** Validate the type/field pairing and normalize; collect human-readable warnings. */
function normalizeBlocks(
  blocks: Block[],
  sectionsByTitle: Map<string, ResolvedSection>,
  warnings: string[],
): Block[] {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.type === "section") {
      if (!b.section || !sectionsByTitle.has(b.section)) {
        warnings.push(`dropped section block with unknown/missing title: ${JSON.stringify(b.section)}`);
        continue;
      }
      out.push({ type: "section", section: b.section });
    } else if (b.type === "triBand") {
      const known = (b.sections ?? []).filter((t) => sectionsByTitle.has(t));
      if (known.length < 2) {
        warnings.push(`triBand needs ≥2 known sections, got ${JSON.stringify(b.sections)} — demoting`);
        for (const t of known) out.push({ type: "section", section: t });
        continue;
      }
      out.push({ type: "triBand", sections: known.slice(0, 3) });
    } else if (b.type === "collage") {
      out.push({ type: "collage", itemIds: b.itemIds ?? [] });
    }
  }
  return out;
}

/** Which section titles are already placed by section/triBand blocks. */
function coveredTitles(blocks: Block[]): Set<string> {
  const s = new Set<string>();
  for (const b of blocks) {
    if (b.type === "section" && b.section) s.add(b.section);
    if (b.type === "triBand") for (const t of b.sections ?? []) s.add(t);
  }
  return s;
}

/** Resolve a collage block's ids into real photo items (photo-truth), clamped to 3–5. */
function resolveCollage(ids: string[], ctx: RenderContext): MenuItem[] {
  const byId = new Map(ctx.photoCandidates.map((c) => [c.id, c]));
  const picked: MenuItem[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const it = byId.get(id);
    if (it && it.imageUrl && !seen.has(id)) {
      picked.push(it);
      seen.add(id);
    }
  }
  // pad to at least 3 from remaining candidates
  for (const c of ctx.photoCandidates) {
    if (picked.length >= 3) break;
    if (!seen.has(c.id) && c.imageUrl) {
      picked.push(c);
      seen.add(c.id);
    }
  }
  return picked.slice(0, 5);
}

export function render(comp: Composition, ctx: RenderContext): RenderResult {
  const warnings: string[] = [];
  const sectionsByTitle = new Map(ctx.sections.map((s) => [s.title, s]));

  let blocks = normalizeBlocks(comp.blocks, sectionsByTitle, warnings);

  // COVERAGE GUARANTEE: append any section the LLM forgot as its own full-width block.
  const covered = coveredTitles(blocks);
  const missing = ctx.sections.filter((s) => !covered.has(s.title));
  if (missing.length > 0) {
    warnings.push(`coverage: appended ${missing.length} forgotten section(s): ${missing.map((s) => s.title).join(", ")}`);
    for (const s of missing) blocks.push({ type: "section", section: s.title });
  }

  const f = fit(blocks, sectionsByTitle, ctx.canvas);
  const r = f.register;

  // ── expand blocks ──
  let sectionNumber = 0;
  const body = blocks
    .map((b) => {
      if (b.type === "collage") {
        const cards = resolveCollage(b.itemIds ?? [], ctx);
        if (cards.length === 0) return "";
        return polaroidCollage(cards, r, collageBandHeight(r));
      }
      if (b.type === "triBand") {
        const secs = (b.sections ?? [])
          .map((t) => sectionsByTitle.get(t))
          .filter((s): s is ResolvedSection => Boolean(s));
        const start = sectionNumber + 1;
        sectionNumber += secs.length;
        return triBand(secs, start, r);
      }
      const sec = sectionsByTitle.get(b.section!)!;
      sectionNumber += 1;
      return (
        `<div>` +
        sectionHeader(sectionNumber, sec.title, r) +
        priceList(sec.items, sectionColumns(sec.items.length), r) +
        `</div>`
      );
    })
    .filter(Boolean)
    .join("");

  const cssVars = Object.entries(TOKENS)
    .map(([k, v]) => `--color-${k}:${v}`)
    .join(";");

  const html =
    `<!DOCTYPE html><html><head><meta charset="utf-8">` +
    `<link rel="preconnect" href="https://fonts.googleapis.com">` +
    `<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin="anonymous">` +
    `<link href="https://fonts.googleapis.com/css2?family=Archivo:wght@500;600;700;800&family=Shrikhand&display=swap" rel="stylesheet">` +
    `<style>:root{${cssVars}}*{box-sizing:border-box}body{margin:0}</style></head><body>` +
    // stripe frame (shell — always emitted)
    `<div style="width:${ctx.canvas.width}px;height:${ctx.canvas.height}px;` +
    `background:repeating-linear-gradient(45deg,var(--color-accent) 0 16px,var(--color-stripe) 16px 32px);` +
    `padding:16px;box-sizing:border-box;overflow:hidden">` +
    `<div style="width:100%;height:100%;background:var(--color-bg);color:var(--color-text);` +
    `font-family:'Archivo',sans-serif;display:flex;flex-direction:column;overflow:hidden">` +
    masthead(comp.title, ctx.tagline, r) +
    `<div style="flex:1;display:flex;flex-direction:column;justify-content:space-between;` +
    `padding:24px 36px 30px;min-height:0">${body}</div>` +
    `</div></div></body></html>`;

  return { html, finalBlocks: blocks, fit: f, warnings };
}
