import { MatrixCoverageError } from "../domain/errors";
import type { CanonicalItem, SectionMatrix } from "../domain/types";

/**
 * Cross-category comparison matrices (pure core). The LLM plan carries only category names + a
 * free-text layoutHint; it never pairs "Pachi Mirchi Chicken Biryani" ↔ "Pachi Mirchi Chicken
 * Pulav" across 34 items. Prose in the matrix blueprint did not stop the painter rendering stacked
 * name+price cards instead of a real row×column table, so we compute the pairing HERE and hand the
 * painter the exact grid.
 *
 * The row key is a base dish derived by normalising each item's name: strip a trailing "*", drop
 * punctuation, and case-insensitively remove the item's own category token(s). Items across columns
 * that normalise to the same base share a row. Two items in the SAME category that normalise to the
 * same base do NOT merge (they get separate, disambiguated rows). NOTHING is ever dropped — an
 * item-per-cell invariant is asserted and throws {@link MatrixCoverageError} on violation.
 */

/** Strip a trailing "*" (menu "signature/spicy" marker) and collapse internal whitespace. */
function stripName(name: string): string {
  return name
    .replace(/\s*\*+\s*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Normalise to a comparison key: lowercase, drop punctuation, collapse whitespace. */
function normalizeKey(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** The lowercased word tokens of a category name, for whole-word removal from an item name. */
function categoryTokens(category: string): Set<string> {
  return new Set(normalizeKey(category).split(" ").filter(Boolean));
}

/**
 * Derive the base-dish label (original casing preserved) by dropping the category's own tokens
 * from the item name (e.g. remove "Biryani" from "Chicken Dum Biryani *" → "Chicken Dum"). Returns
 * "" when nothing remains — the caller then falls back to the full stripped name.
 */
function baseLabel(strippedName: string, catTokens: Set<string>): string {
  return strippedName
    .split(/\s+/)
    .filter((word) => {
      const norm = normalizeKey(word);
      return norm.length > 0 && !catTokens.has(norm);
    })
    .join(" ")
    .trim();
}

interface MutableRow {
  label: string;
  cells: (string | null)[];
}

/**
 * Build a {@link SectionMatrix} from the block's category `columns` and the items grouped by
 * category. Column order is preserved; row order is first-appearance order across the columns
 * (column-major, since a block flattens its categories in order).
 */
export function buildMatrix(
  columns: string[],
  itemsByCategory: Map<string, CanonicalItem[]>,
): SectionMatrix {
  const rows: MutableRow[] = [];
  /** base key → the first row that owns it (so later columns pair onto it). */
  const rowByKey = new Map<string, number>();
  let total = 0;

  columns.forEach((column, ci) => {
    const catTokens = categoryTokens(column);
    for (const item of itemsByCategory.get(column) ?? []) {
      total += 1;
      const strippedFull = stripName(item.name);
      const derived = baseLabel(strippedFull, catTokens);
      const label = derived !== "" ? derived : strippedFull;
      const key = normalizeKey(label);

      const owner = rowByKey.get(key);
      // A same-column collision = the owning row's cell for THIS column is already filled. Never
      // merge two dishes from one category onto one row — give the collision its own row (labelled
      // with its full name so it stays distinguishable).
      const collided = owner !== undefined && rows[owner]!.cells[ci] !== null;

      let ri: number;
      if (owner === undefined || collided) {
        ri = rows.length;
        rows.push({ label: collided ? strippedFull : label, cells: columns.map(() => null) });
        if (owner === undefined) rowByKey.set(key, ri);
      } else {
        ri = owner;
      }
      rows[ri]!.cells[ci] = item.id;
    }
  });

  const matrix: SectionMatrix = { columns: [...columns], rows };

  // Hard invariant: every input item landed in exactly one cell (mirrors coverage philosophy).
  const placed = rows.reduce((n, r) => n + r.cells.filter((c) => c !== null).length, 0);
  if (placed !== total) {
    throw new MatrixCoverageError(
      `matrix coverage: placed ${placed} of ${total} item(s) across ${columns.join(" × ")}.`,
      { details: { placed, total, columns } },
    );
  }
  return matrix;
}

/** The canonical item ids carried by a matrix's cells (non-null), in row-major order. */
export function matrixItemIds(matrix: SectionMatrix): string[] {
  const ids: string[] = [];
  for (const row of matrix.rows) for (const cell of row.cells) if (cell !== null) ids.push(cell);
  return ids;
}

// NOTE: `splitMatrixRows` (spreading a too-tall matrix across boards) was removed with D25 —
// categories are atomic and a matrix section never splits across screens.
