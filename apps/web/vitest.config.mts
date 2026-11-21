import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname) } },
  test: {
    include: ["**/*.test.ts"],
    exclude: ["node_modules/**", ".next/**"],
    setupFiles: ["test/setup.ts"],
    // next-auth imports "next/server" without the extension, which Node's resolver refuses;
    // inlined, Vite resolves it. Needed by the tests that run the real Auth.js handlers.
    server: { deps: { inline: ["next-auth"] } },
    // Every test file shares one PostgreSQL database.
    fileParallelism: false,
    testTimeout: 20_000,
  },
});
