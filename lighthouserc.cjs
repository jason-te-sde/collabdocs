// Lighthouse CI: performance and accessibility must each be at least 0.92 on
// the median of three runs, on three pages, against a production build with the
// collab server, PostgreSQL and Redis running (see the lighthouse job in
// .github/workflows/ci.yml, which starts them and runs scripts/lighthouse/seed.mjs).
const { existsSync, readFileSync } = require("node:fs");

const WEB_URL = process.env.WEB_URL ?? "http://localhost:3000";
const seedFile = ".lighthouseci-seed.json";
if (!existsSync(seedFile))
  throw new Error(`${seedFile} is missing; run scripts/lighthouse/seed.mjs first`);
const { documentId } = JSON.parse(readFileSync(seedFile, "utf8"));

const median = { minScore: 0.92, aggregationMethod: "median" };

module.exports = {
  ci: {
    collect: {
      // The sign-in page first: the script clears the session for it, and sets it for the others.
      url: [`${WEB_URL}/sign-in`, `${WEB_URL}/documents`, `${WEB_URL}/documents/${documentId}`],
      numberOfRuns: 3,
      puppeteerScript: "scripts/lighthouse/auth.cjs",
      chromePath: process.env.CHROME_PATH || "/usr/bin/google-chrome",
      puppeteerLaunchOptions: { args: ["--no-sandbox", "--disable-dev-shm-usage"] },
      settings: {
        preset: "desktop",
        onlyCategories: ["performance", "accessibility"],
        disableStorageReset: true,
      },
    },
    assert: {
      assertions: {
        "categories:performance": ["error", median],
        "categories:accessibility": ["error", median],
      },
    },
    upload: { target: "filesystem", outputDir: ".lighthouseci/report" },
  },
};
