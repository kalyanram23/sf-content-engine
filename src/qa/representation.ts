import type { HTMLElement } from "node-html-parser";

import type { QaConfig } from "../config/qa";
import type { CanonicalItem, PlanScreen, QaFinding } from "../domain/types";
import { FindingKind, makeFinding } from "./finding";

/**
 * Capacity + representation-correctness oracles (pure). Capacity drives the §5.6 re-plan
 * escalation on a concrete signal (review S1); the representation oracle is the
 * non-tautological structural check for acceptance test #3 (spec §7).
 */

/** Planned items exceeding a representation's slot capacity → structural re-plan signal. */
export function checkCapacity(plan: PlanScreen, qa: QaConfig): QaFinding[] {
  const findings: QaFinding[] = [];
  for (const section of plan.sections) {
    const slotCount = qa.capacities[section.representation];
    if (slotCount === undefined) continue;
    if (section.items.length > slotCount) {
      findings.push(
        makeFinding({
          kind: FindingKind.OverflowCapacity,
          source: "deterministic",
          severity: "major",
          tag: "structural",
          region: section.title,
          message: `Section "${section.title}" allocates ${section.items.length} items to a ${section.representation} (capacity ${slotCount}); a re-paint cannot fix this — re-plan.`,
          data: {
            representation: section.representation,
            plannedCount: section.items.length,
            slotCount,
            section: section.title,
          },
        }),
      );
    }
  }
  return findings;
}

/**
 * Structural correctness of each representation against the SOURCE item (not the painter's
 * output): a `matrix` must bind a price cell per size; `variant-rows` must show each variant.
 */
export function checkRepresentations(
  root: HTMLElement,
  plan: PlanScreen,
  items: CanonicalItem[],
): QaFinding[] {
  const findings: QaFinding[] = [];
  const itemsById = new Map(items.map((i) => [i.id, i]));

  for (const section of plan.sections) {
    for (const id of section.items) {
      const item = itemsById.get(id);
      if (!item) continue;
      const node = root.querySelector(`[data-item-id="${id}"]`);
      if (!node) continue; // missing item is reported by the binding check

      if (section.representation === "matrix" && item.sizes && item.sizes.length > 0) {
        const priceHooks = node.querySelectorAll('[data-bind="price"]').length;
        if (priceHooks < item.sizes.length) {
          findings.push(
            makeFinding({
              kind: FindingKind.Representation,
              source: "deterministic",
              severity: "major",
              tag: "content",
              itemId: id,
              region: section.title,
              message: `Matrix for "${id}" has ${priceHooks} price cells but the item has ${item.sizes.length} sizes.`,
              data: { representation: "matrix", priceHooks, sizes: item.sizes.length },
            }),
          );
        }
      }

      if (section.representation === "variant-rows" && item.variants && item.variants.length > 0) {
        const text = node.text.toLowerCase();
        const missing = item.variants
          .map((v) => v.label)
          .filter((label) => !text.includes(label.toLowerCase()));
        if (missing.length > 0) {
          findings.push(
            makeFinding({
              kind: FindingKind.Representation,
              source: "deterministic",
              severity: "major",
              tag: "content",
              itemId: id,
              region: section.title,
              message: `Variant-rows for "${id}" is missing variant(s): ${missing.join(", ")}.`,
              data: { representation: "variant-rows", missing },
            }),
          );
        }
      }
    }
  }
  return findings;
}
