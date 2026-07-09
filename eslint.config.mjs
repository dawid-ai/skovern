import tseslint from "typescript-eslint";

export default tseslint.config(
  { ignores: ["**/dist/**", "**/out/**", "**/node_modules/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // CLAUDE.md: no `any` without a written why — enforced here, not by prose
      "@typescript-eslint/no-explicit-any": "error",
    },
  },
);
