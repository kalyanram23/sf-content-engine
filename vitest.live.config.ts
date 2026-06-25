import { defineConfig } from "vitest/config";

// Load credentials from .env (OPENROUTER_API_KEY, RUN_BROWSER_TESTS, …) before the suite runs,
// so live tests read them without a manual `export`. Falls back to the ambient environment.
try {
  process.loadEnvFile();
} catch {
  /* no .env file — use the existing process environment */
}

/**
 * Live/integration tests (`npm run test:live`): real browser binary and/or `OPENROUTER_API_KEY`.
 * Each test skips itself when its prerequisite is absent, so this is safe to run anywhere.
 */
export default defineConfig({
  test: {
    include: ["src/**/*.live.test.ts"],
    environment: "node",
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
