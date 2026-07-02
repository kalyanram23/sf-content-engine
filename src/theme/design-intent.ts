import type { ResolvedTheme } from "../domain/types";

/**
 * Distill a resolved theme into the short DESIGN INTENT brief handed to the vision critic, so
 * "theme-adherence" and "intentional-design" are graded against what the theme actually asked
 * for instead of a generic notion of "designed". Pure prose only — never token hex values (a
 * VLM can't reliably read hex off a screenshot; palette enforcement stays with the
 * deterministic token-lint) and never asset/font data-URIs.
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
  const donts = [...(theme.design?.dont ?? []), ...(antiPatterns ?? [])];
  if (donts.length > 0) {
    lines.push(
      `Declared DON'Ts — report a finding only for one you can SEE violated:\n${donts
        .slice(0, 10)
        .map((d) => `- ${d}`)
        .join("\n")}`,
    );
  }
  return lines.join("\n");
}
