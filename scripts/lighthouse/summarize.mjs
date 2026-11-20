#!/usr/bin/env node
// Prints the median performance and accessibility score per page from the
// reports that `lhci collect` saved, as a Markdown table (and appends it to the
// GitHub job summary when there is one).
//
// Exits 1 when a report cannot be trusted: Lighthouse reported a runtime error (the page
// could not be reached or loaded), a page was redirected to another one, a score is
// missing, or the editor page was scored without its collaboration socket having
// synced (the app makes the User Timing mark `collabdocs:synced` then, and Lighthouse
// lists it in the `user-timings` audit).
//
// usage: node scripts/lighthouse/summarize.mjs [dir]   (default .lighthouseci)
import { appendFileSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const dir = process.argv[2] ?? ".lighthouseci";
const byUrl = new Map();
let failed = false;
const SYNCED_MARK = "collabdocs:synced";
for (const name of readdirSync(dir)) {
  if (!/^lhr-.*\.json$/.test(name)) continue;
  const lhr = JSON.parse(readFileSync(path.join(dir, name), "utf8"));
  const { pathname } = new URL(lhr.requestedUrl);
  const page = pathname.startsWith("/documents/") ? "/documents/:id" : pathname;
  const runs = byUrl.get(page) ?? [];
  if (lhr.runtimeError) {
    console.error(
      `${page}: Lighthouse could not measure the page (${lhr.runtimeError.code}: ${lhr.runtimeError.message})`,
    );
    failed = true;
    continue;
  }
  if (new URL(lhr.finalDisplayedUrl).pathname !== pathname) {
    // A redirect (for example to the sign-in page) would score the wrong page.
    console.error(`${page}: measured ${lhr.finalDisplayedUrl}, not the page that was asked for`);
    failed = true;
  }
  if (page === "/documents/:id") {
    const marks = lhr.audits?.["user-timings"]?.details?.items ?? [];
    if (!marks.some((item) => item.name === SYNCED_MARK)) {
      console.error(
        `${page}: the editor was scored without its socket synced (no ${SYNCED_MARK} mark in the report)`,
      );
      failed = true;
    }
  }
  const audit = (id) => lhr.audits[id].numericValue;
  const { performance, accessibility } = lhr.categories;
  if (typeof performance?.score !== "number" || typeof accessibility?.score !== "number") {
    console.error(`${page}: the report has no performance or accessibility score`);
    failed = true;
    continue;
  }
  runs.push({
    lcp: audit("largest-contentful-paint"),
    tbt: audit("total-blocking-time"),
    cls: audit("cumulative-layout-shift"),
    performance: performance.score,
    accessibility: accessibility.score,
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
  if (runs.length === 0) continue;
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
if (failed) process.exit(1);
