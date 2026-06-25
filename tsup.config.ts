import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    node: "src/node.ts",
    testing: "src/testing.ts",
  },
  format: ["esm"],
  target: "node20",
  outDir: "dist",
  dts: true,
  clean: true,
  treeshake: true,
  sourcemap: true,
  splitting: true,
  // Heavy/optional backends are peer deps — never bundle them into the library.
  external: ["openai", "playwright-core", "playwright", "tailwindcss", "@tailwindcss/node"],
});
