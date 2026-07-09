import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/**/*.test.ts"],
    // Spinning up a throwaway Postgres container costs a first-pull + boot.
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
