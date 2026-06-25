import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["dist", "node_modules", "coverage", "playground-output"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": ["warn", { allow: ["warn", "error"] }],
    },
  },
  {
    // CLI entry points; console output is their whole job.
    files: ["src/playground/**/*.ts", "scripts/**/*.ts"],
    rules: { "no-console": "off" },
  },
  {
    // The Playwright adapter declares browser globals (document/window/getComputedStyle)
    // that have no Node type without pulling the DOM lib into the pure core — `any` is
    // intentional and scoped to this single boundary file.
    files: ["src/adapters/playwright/browser.ts"],
    rules: { "@typescript-eslint/no-explicit-any": "off" },
  },
  {
    // Hermetic-core boundary (D6/S9): only src/node.ts and src/adapters/** may touch the
    // optional peer deps or the adapter modules. This keeps `npm run verify` browser/key-free.
    files: ["src/**/*.ts"],
    ignores: ["src/node.ts", "src/adapters/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "openai", message: "Import LLM SDKs only in src/adapters/** (hermetic core)." },
            {
              name: "playwright",
              message: "Import the browser only in src/adapters/** (hermetic core).",
            },
            {
              name: "playwright-core",
              message: "Import the browser only in src/adapters/** (hermetic core).",
            },
            {
              name: "tailwindcss",
              message: "Import Tailwind only in src/adapters/** (hermetic core).",
            },
            {
              name: "@tailwindcss/node",
              message: "Import Tailwind only in src/adapters/** (hermetic core).",
            },
          ],
          patterns: [
            {
              group: ["**/adapters/*", "**/adapters/**"],
              message: "Only src/node.ts may import adapters (keeps the core + tests hermetic).",
            },
          ],
        },
      ],
    },
  },
);
