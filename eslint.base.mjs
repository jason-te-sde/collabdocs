import js from "@eslint/js";
import globals from "globals";
import tseslint from "typescript-eslint";

/** Shared flat config for the packages that are not Next.js apps. */
export default [
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  { ignores: ["dist/**", "coverage/**", "node_modules/**"] },
];
