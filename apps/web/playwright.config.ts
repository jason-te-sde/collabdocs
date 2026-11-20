import path from "node:path";
import { defineConfig } from "@playwright/test";

/**
 * End-to-end tests: a real browser against the built web app and a real collab
 * server, both started here, with PostgreSQL and Redis running.
 *
 *   DATABASE_URL=postgresql://you@localhost:5432/collabdocs_test npm run build -w apps/web
 *   DATABASE_URL=... npm run test:e2e -w apps/web
 *
 * The tests create their own users with unique emails and delete nothing.
 * PW_CHANNEL=chrome runs them in an installed Google Chrome instead of the
 * Chromium that `npx playwright install chromium` downloads.
 */
const WEB_PORT = 3100;
const COLLAB_PORT = 4100;
export const WEB_URL = `http://localhost:${WEB_PORT}`;

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is not set; the e2e tests need PostgreSQL");

const env = {
  ...process.env,
  DATABASE_URL: databaseUrl,
  REDIS_URL: process.env.REDIS_URL ?? "redis://localhost:6379",
  AUTH_SECRET: "e2e-auth-secret-that-is-long-enough-0123456789",
  AUTH_URL: WEB_URL,
  AUTH_TRUST_HOST: "true",
  COLLAB_TOKEN_SECRET: "e2e-collab-secret-0123456789-abcdefghijklmnop",
  COLLAB_URL: `http://localhost:${COLLAB_PORT}`,
  COLLAB_PORT: String(COLLAB_PORT),
  COLLAB_CORS_ORIGIN: WEB_URL,
  // A removed member must lose access within the test's patience even if the Redis message were lost.
  COLLAB_MEMBERSHIP_RECHECK_MS: "5000",
};

export default defineConfig({
  testDir: "./e2e",
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: WEB_URL,
    trace: "retain-on-failure",
    ...(process.env.PW_CHANNEL ? { channel: process.env.PW_CHANNEL } : {}),
  },
  webServer: [
    {
      command: "npm run start -w @collabdocs/collab",
      cwd: path.resolve(__dirname, "../.."),
      url: `http://localhost:${COLLAB_PORT}/healthz`,
      env,
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `npm run start -- --port ${WEB_PORT}`,
      cwd: __dirname,
      url: `${WEB_URL}/sign-in`,
      env,
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
