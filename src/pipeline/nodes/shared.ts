import type { CanonicalItem, PlanScreen, ThinPlan } from "../../domain/types";

/** The plan screen this run is painting (the engine loops the graph over every screen). */
export function currentScreen(plan: ThinPlan, index = 0): PlanScreen {
  const screen = plan.screens[index];
  if (!screen) throw new Error(`plan has no screen at index ${index}`);
  return screen;
}

/** The canonical items referenced by a screen (sections + image slot), de-duplicated. */
export function resolveScreenItems(
  screen: PlanScreen,
  all: readonly CanonicalItem[],
): CanonicalItem[] {
  const byId = new Map(all.map((i) => [i.id, i]));
  const ids = new Set<string>();
  for (const section of screen.sections) for (const id of section.items) ids.add(id);
  for (const id of screen.imageSlot?.items ?? []) ids.add(id);
  return [...ids].map((id) => byId.get(id)).filter((i): i is CanonicalItem => i !== undefined);
}

/** Unique canonical IDs allocated to a screen's sections (the binding contract surface). */
export function plannedSectionItemIds(screen: PlanScreen): string[] {
  const ids = new Set<string>();
  for (const section of screen.sections) for (const id of section.items) ids.add(id);
  return [...ids];
}
