#!/usr/bin/env node
// Prints the median performance and accessibility score per page from the
// reports that `lhci collect` saved, as a Markdown table (and appends it to the
// GitHub job summary when there is one).
//
// usage: node scripts/lighthouse/summarize.mjs [dir]   (default .lighthouseci)
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2] ?? ".lighthouseci";
const byUrl = new Map();
let redirected = false;
for (const name of readdirSync(dir)) {
  if (!/^lhr-.*\.json$/.test(name)) continue;
  const lhr = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
  const { pathname } = new URL(lhr.requestedUrl);
  const page = pathname.startsWith("/documents/") ? "/documents/:id" : pathname;
  const runs = byUrl.get(page) ?? [];
  if (new URL(lhr.finalDisplayedUrl).pathname !== pathname) {
    // A redirect (for example to the sign-in page) would score the wrong page.
    console.error(`${page}: measured ${lhr.finalDisplayedUrl}, not the page that was asked for`);
    redirected = true;
  }
  const audit = (id) => lhr.audits[id].numericValue;
  runs.push({
    lcp: audit("largest-contentful-paint"),
    tbt: audit("total-blocking-time"),
    cls: audit("cumulative-layout-shift"),
    performance: lhr.categories.performance.score,
    accessibility: lhr.categories.accessibility.score,
    preset: lhr.configSettings.formFactor,
    version: lhr.lighthouseVersion,
  });
  byUrl.set(page, runs);
}

const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
};

const lines = [
  "| Page | Runs | Performance (median) | Accessibility (median) | LCP ms (median) | TBT ms (median) | CLS (median) | All performance scores |",
  "| --- | --- | --- | --- | --- | --- | --- | --- |",
];
let version = "";
let formFactor = "";
for (const [page, runs] of [...byUrl].sort()) {
  version = runs[0].version;
  formFactor = runs[0].preset;
  lines.push(
    `| \`${page}\` | ${runs.length} | ${median(runs.map((r) => r.performance))} | ${median(runs.map((r) => r.accessibility))} | ${Math.round(median(runs.map((r) => r.lcp)))} | ${Math.round(median(runs.map((r) => r.tbt)))} | ${median(runs.map((r) => r.cls)).toFixed(3)} | ${runs.map((r) => r.performance).join(", ")} |`,
  );
}
lines.push("", `Lighthouse ${version}, form factor ${formFactor}.`);
const text = lines.join("\n");
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${text}\n`);
if (redirected) process.exit(1);
