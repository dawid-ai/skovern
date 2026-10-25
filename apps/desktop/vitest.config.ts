import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // e2e/ belongs to Playwright, not Vitest
    include: ["src/**/*.test.ts", "scripts/**/*.test.ts"],
  },
});
