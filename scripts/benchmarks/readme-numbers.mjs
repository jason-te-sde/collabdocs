#!/usr/bin/env node
// Keeps the README's Performance section honest: every number in it must come from a
// committed results file.
//
// usage: node scripts/benchmarks/readme-numbers.mjs [--write] [--readme README.md] [--results DIR]
//   (default)  check: exit 1 and list the problems if
//                - there are no results files,
//                - the table between the performance-table markers is not what the results
//                  files produce, or
//                - a number elsewhere in the Performance section appears in no results file
//                  (as it is, or rounded to 0 to 3 decimals).
//   --write    replace the table between the markers with the generated one
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const START = "<!-- performance-table:start -->";
export const END = "<!-- performance-table:end -->";
const DEFAULT_RESULTS = "apps/collab/bench/results";
const CLAIM_EDITORS = 50;
const CLAIM_P95_MS = 100;
const CLAIM_MIN_RUNS = 3;

/** Standalone numbers in text: digits not glued to a letter, with thousands commas removed. */
export function numbersIn(text) {
  return [...text.matchAll(/(?<![\w.])\d+(?:[.,]\d+)*/g)].map((m) => m[0].replaceAll(",", ""));
}

/** A number as it may be printed: whole, or rounded to 0 to 3 decimals (with and without trailing zeros). */
function forms(value) {
  const out = new Set([String(value)]);
  for (let decimals = 0; decimals <= 3; decimals += 1) {
    const fixed = value.toFixed(decimals);
    out.add(fixed);
    out.add(String(Number(fixed)));
  }
  return out;
}

/** Every number that a results file contains, in the forms a README may print it. */
export function allowedNumbers(results) {
  const allowed = new Set();
  const visit = (value) => {
    if (typeof value === "number" && Number.isFinite(value)) {
      for (const form of forms(value)) allowed.add(form);
    } else if (typeof value === "string") {
      // Digits glued to letters count here ("v25.6.1" has 25.6.1): the files are not prose.
      for (const match of value.matchAll(/\d+(?:\.\d+)*/g)) allowed.add(match[0]);
    } else if (Array.isArray(value)) {
      value.forEach(visit);
    } else if (value && typeof value === "object") {
      Object.values(value).forEach(visit);
    }
  };
  results.forEach(visit);
  return allowed;
}

export function loadResults(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.startsWith("_"))
    .map((name) => ({ file: name, ...JSON.parse(readFileSync(path.join(dir, name), "utf8")) }))
    .sort(
      (a, b) =>
        a.parameters.editors - b.parameters.editors ||
        String(a.startedAt).localeCompare(String(b.startedAt)) ||
        a.label.localeCompare(b.label),
    );
}

const fixed = (value, decimals) => value.toFixed(decimals);

function claimSentence(results) {
  const counted = results.filter(
    (r) => r.parameters.editors === CLAIM_EDITORS && r.verdict.status !== "invalid",
  );
  if (counted.length < CLAIM_MIN_RUNS) {
    return `**Not determined:** ${counted.length} runs at ${CLAIM_EDITORS} editors, ${CLAIM_MIN_RUNS} are needed.`;
  }
  const worst = Math.max(...counted.map((r) => r.latencyMs.p95));
  if (counted.some((r) => r.verdict.status === "failed")) {
    return `**Not supported as measured:** a run at ${CLAIM_EDITORS} editors failed (highest p95 ${fixed(worst, 1)} ms).`;
  }
  if (worst < CLAIM_P95_MS) {
    return `**The claim holds as defined:** the p95 of every one of the ${counted.length} valid runs at ${CLAIM_EDITORS} editors is below ${CLAIM_P95_MS} ms (highest ${fixed(worst, 1)} ms).`;
  }
  return `**The claim does not hold as defined:** the highest p95 of the ${counted.length} runs at ${CLAIM_EDITORS} editors is ${fixed(worst, 1)} ms, not below ${CLAIM_P95_MS} ms.`;
}

/** The table of every run, with its status, and the one-line verdict on the claim. */
export function renderTable(results) {
  const rows = results.map((r) => {
    const lag = Math.max(0, ...r.generator.map((g) => g.eventLoopDelayMs.p99));
    return `| \`${r.file ?? `${r.label}.json`}\` | ${r.parameters.editors} (${r.parameters.writers} writing) | ${fixed(r.latencyMs.p50, 1)} | ${fixed(r.latencyMs.p95, 1)} | ${fixed(r.latencyMs.p99, 1)} | ${fixed(r.server.rssMiB.windowMax, 0)} | ${fixed(r.server.cpuPercentOfOneCore.windowMean, 0)} | ${fixed(lag, 1)} | ${r.verdict.status} |`;
  });
  return [
    "| Results file | Editors | p50 (ms) | p95 (ms) | p99 (ms) | Server RSS, highest (MiB) | Server CPU, mean (% of a core) | Generator lag p99, worst process (ms) | Status |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    claimSentence(results),
  ].join("\n");
}

function table(results) {
  return `${START}\n${renderTable(results)}\n${END}`;
}

/** The README with the table between the markers replaced (or added after the Performance heading). */
export function withTable(readme, results) {
  const block = table(results);
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start >= 0 && end > start)
    return readme.slice(0, start) + block + readme.slice(end + END.length);
  return readme.replace(/^## Performance\n/m, `## Performance\n\n${block}\n`);
}

/** The text of the Performance section: from its heading to the next second-level heading. */
export function performanceSection(readme) {
  const match = /^## Performance\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(readme);
  return match ? match[1] : "";
}

export function checkReadme(readme, results) {
  if (results.length === 0) return ["there are no results files"];
  const problems = [];
  const start = readme.indexOf(START);
  const end = readme.indexOf(END);
  if (start < 0 || end < start) {
    return [`the README has no ${START} ... ${END} block in its Performance section`];
  }
  const current = readme.slice(start, end + END.length);
  if (current !== table(results)) {
    problems.push(
      "the performance table is not what the results files produce; run: node scripts/benchmarks/readme-numbers.mjs --write",
    );
  }
  const allowed = allowedNumbers(results);
  const section = performanceSection(readme);
  const sectionStart = readme.indexOf(section);
  const lineOf = (offset) => readme.slice(0, offset).split("\n").length;
  const outsideTable = (offset) =>
    sectionStart + offset < start || sectionStart + offset > end + END.length;
  for (const match of section.matchAll(/(?<![\w.])\d+(?:[.,]\d+)*/g)) {
    if (!outsideTable(match.index)) continue;
    const number = match[0].replaceAll(",", "");
    if (!allowed.has(number)) {
      problems.push(`line ${lineOf(sectionStart + match.index)}: ${number} is in no results file`);
    }
  }
  return problems;
}

function main() {
  const arg = (name, fallback) => {
    const index = process.argv.indexOf(`--${name}`);
    return index >= 0 ? process.argv[index + 1] : fallback;
  };
  const readmePath = arg("readme", "README.md");
  const results = loadResults(arg("results", DEFAULT_RESULTS));
  const readme = readFileSync(readmePath, "utf8");
  if (process.argv.includes("--write")) {
    writeFileSync(readmePath, withTable(readme, results));
    console.log(`readme-numbers: wrote the table for ${results.length} results files`);
    return;
  }
  const problems = checkReadme(readme, results);
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    console.error(`readme-numbers: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(`readme-numbers: ok (${results.length} results files)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
