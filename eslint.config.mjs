import tseslint from "typescript-eslint";
import vitest from "@vitest/eslint-plugin";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/out/**", "**/node_modules/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // CLAUDE.md: no `any` without a written why — enforced here, not by prose
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
  {
    files: ["**/*.test.ts", "**/*.spec.ts", "**/e2e/**/*.ts"],
    plugins: { vitest },
    rules: {
      // Retro (012b F1): a bare `toThrow()` / `rejects.toThrow()` passes on a
      // connection/DNS error too, which is exactly how an SSRF bypass hid behind a
      // green test. A negative test must pin WHY it threw. Enforced at lint
      // (iteration 0), not left to a reviewer to notice.
      "vitest/require-to-throw-message": "error",
    },
  },
);
