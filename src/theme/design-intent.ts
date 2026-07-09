import type { ResolvedTheme } from "../domain/types";

/**
 * Distill a resolved theme into the short DESIGN INTENT brief handed to the vision critic, so
 * "theme-adherence" and "intentional-design" are graded against what the theme actually asked
 * for instead of a generic notion of "designed". Emits BOTH declared lists in full — the theme's
 * DOs (the positive spec to reward when visibly honoured) before its DON'Ts (merged with the
 * engine anti-patterns) — with no truncation, so no declared rule is silently dropped (D68). Pure
 * prose only — never token hex values (a VLM can't reliably read hex off a screenshot; palette
 * enforcement stays with the deterministic token-lint) and never asset/font data-URIs.
 */
export function describeDesignIntent(
  theme: ResolvedTheme,
  antiPatterns?: readonly string[],
): string {
  const lines: string[] = [
    `Theme "${theme.name}" (density: ${theme.density}${theme.motif ? `, motif: ${theme.motif}` : ""}).`,
  ];
  const identity = theme.design?.identity.trim() ?? theme.prompt?.trim();
  if (identity !== undefined && identity !== "") lines.push(identity);
  // DOs before DON'Ts: the critic must hear the POSITIVE spec it is grading "theme-adherence"
  // against — a board that visibly honours a declared DO (e.g. dhaba's truck-art stripe frame) must
  // be rewarded for it, not flagged for a spec the critic was guessing at from the identity prose.
  const dos = theme.design?.do ?? [];
  if (dos.length > 0) {
    lines.push(
      `Declared DOs — grade positively when you can SEE them honoured:\n${dos
        .map((d) => `- ${d}`)
        .join("\n")}`,
    );
  }
  // Declared theme don'ts + engine anti-patterns, emitted IN FULL. No truncation: a silently
  // dropped rule is a rule the critic never grades against, and it would asymmetrically favour
  // whichever list came first. The combined list is small and bounded — themes declare a handful of
  // don'ts (≤5 across all shipped themes) and `painter.antiPatterns` is a fixed config list (~7) —
  // so there is nothing to cap (D68).
  const donts = [...(theme.design?.dont ?? []), ...(antiPatterns ?? [])];
  if (donts.length > 0) {
    lines.push(
      `Declared DON'Ts — report a finding only for one you can SEE violated:\n${donts
        .map((d) => `- ${d}`)
        .join("\n")}`,
    );
  }
  return lines.join("\n");
}
