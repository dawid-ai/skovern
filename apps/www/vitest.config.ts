import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    // W3 runs a second full Astro build with a broken post.
    testTimeout: 180_000,
  },
});
