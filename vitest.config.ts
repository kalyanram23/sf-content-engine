import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Live adapter tests hit the network/browser; gated behind `test:live`, never in the default run.
    exclude: ["**/node_modules/**", "**/*.live.test.ts"],
    environment: "node",
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
      exclude: [
        "src/**/*.test.ts",
        "src/testing/**",
        "src/playground/**",
        "src/**/index.ts",
        "src/node.ts",
        // Real adapters hit network/browser/binaries; covered by gated live tests, not the hermetic suite.
        "src/adapters/**",
      ],
    },
  },
});
