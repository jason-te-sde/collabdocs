// eslint-config-next 16 ships flat config directly. Do not route it through
// FlatCompat: that combination throws on ESLint 10, and ESLint is pinned to 9.
import coreWebVitals from "eslint-config-next/core-web-vitals";
import typescript from "eslint-config-next/typescript";

const config = [
  ...coreWebVitals,
  ...typescript,
  {
    rules: {
      "@typescript-eslint/consistent-type-imports": "error",
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
  { ignores: [".next/**", "node_modules/**", "next-env.d.ts"] },
];

export default config;
