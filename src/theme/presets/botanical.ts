import { parseOrThrow } from "../../domain/parse";
import { themePresetSchema } from "../../domain/schemas";
import type { ThemePreset } from "../../domain/types";

/**
 * A subtle botanical line-pattern background as an inline SVG data-URI (offline-safe, §5.1).
 * Procedural SVG handles per-tenant decoration for free (spec §5.3); image-model
 * backgrounds are a later slice (§8).
 */
const LEAF_BACKGROUND =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200">` +
      `<rect width="200" height="200" fill="#1f2a24"/>` +
      `<g fill="none" stroke="#33433a" stroke-width="2" opacity="0.5">` +
      `<path d="M40 160 C40 110 70 90 100 80 C70 100 60 130 60 160 Z"/>` +
      `<path d="M160 40 C160 90 130 110 100 120 C130 100 140 70 140 40 Z"/>` +
      `</g></svg>`,
  );

/**
 * The botanical preset (spec §7 v1). Tokens authored on a scale the token-lint rail
 * enforces; a small motion vocabulary mixing CSS and orchestrated Motion presets (§5.2).
 */
export const botanicalPreset: ThemePreset = parseOrThrow(
  themePresetSchema,
  {
    id: "botanical",
    name: "Botanical",
    tokens: {
      colors: {
        bg: "#1f2a24",
        surface: "#2b3a31",
        "surface-strong": "#35463b",
        text: "#f3efe6",
        muted: "#cbc6b8",
        accent: "#8a9a5b",
        "accent-strong": "#c2cf95",
        price: "#f0d9a7",
        sold: "#7c7468",
      },
      fontFamilies: {
        display: "'Cormorant Garamond', Georgia, serif",
        body: "'Inter', system-ui, sans-serif",
      },
      fontSizes: {
        xs: "1rem",
        sm: "1.25rem",
        base: "1.5rem",
        lg: "2rem",
        xl: "3rem",
        "2xl": "4rem",
        display: "6rem",
      },
      spacing: {
        "0": "0",
        "1": "0.5rem",
        "2": "1rem",
        "3": "1.5rem",
        "4": "2rem",
        "6": "3rem",
        "8": "4rem",
      },
      radius: { sm: "0.5rem", md: "1rem", lg: "1.5rem", full: "9999px" },
    },
    motion: [
      { name: "fade-in", kind: "css", description: "Simple opacity/entrance fade." },
      {
        name: "stagger-in",
        kind: "runtime",
        description: "Staggered entrance of list/grid items.",
      },
      {
        name: "gallery-fade",
        kind: "runtime",
        description: "Cross-fade gallery cycling through photos.",
      },
      {
        name: "ambient-drift",
        kind: "runtime",
        description: "Slow ambient drift of the background motif.",
      },
    ],
    assets: {
      backgrounds: [{ id: "botanical-leaves", dataUri: LEAF_BACKGROUND }],
      fonts: [],
    },
  },
  "botanical preset",
);
