#!/usr/bin/env node
// Keeps the README's Performance section honest: every number in it is bound to its source.
//
// usage: node scripts/benchmarks/readme-numbers.mjs [--write] [--readme README.md]
//                                                   [--results DIR] [--docs docs/benchmarks.md]
//
// The section has two generated blocks, which this script writes from the committed results
// files and compares exactly (after normalising Markdown table padding):
//   performance-text   the claim, the setup, the scenarios, the integrity summary, the
//                      goal-2 verdict and the medians by size
//   performance-table  one row per run, the verdict on the claim, and which instrument
//                      measured the generator lag in which runs
// Every number in those blocks is the value of a field of the results files (or one of the
// claim constants below, which must also appear in the protocol, docs/benchmarks.md),
// printed at a fixed precision. The rest of the section is hand-written and must not
// contain a number at all: no digit and no spelled-out number.
//
//   (default)  check: exit 1 and list the problems
//   --write    regenerate the two blocks in the README
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export const TEXT_START = "<!-- performance-text:start -->";
export const TEXT_END = "<!-- performance-text:end -->";
export const START = "<!-- performance-table:start -->";
export const END = "<!-- performance-table:end -->";
const DEFAULT_RESULTS = "apps/collab/bench/results";
const DEFAULT_DOCS = "docs/benchmarks.md";
export const CLAIM = { editors: 50, p95Ms: 100, minRuns: 3 };
/** Goal 2: how many editors at once on one document. A threshold of its own: it is not the latency claim's size. */
export const GOAL_TWO_MIN_EDITORS = 50;

const SPELLED =
  /\b(one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|fifty|hundred|thousand|first|second|third|fourth|fifth|half|twice|thrice|dozen)\b/i;

export const scenarioOf = (r) => (r.parameters.writerShare === 1 ? "all-write" : "one-in-five");
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const fixed = (value, decimals) => value.toFixed(decimals);

export function loadResults(dir) {
  return readdirSync(dir)
    .filter((name) => name.endsWith(".json") && !name.startsWith("_"))
    .map((name) => ({ file: name, ...JSON.parse(readFileSync(path.join(dir, name), "utf8")) }))
    .sort(
      (a, b) =>
        (scenarioOf(a) === "all-write") - (scenarioOf(b) === "all-write") ||
        a.parameters.editors - b.parameters.editors ||
        String(a.startedAt).localeCompare(String(b.startedAt)) ||
        a.label.localeCompare(b.label),
    );
}

const counted = (results, scenario, editors) =>
  results.filter(
    (r) =>
      scenarioOf(r) === scenario &&
      (editors === undefined || r.parameters.editors === editors) &&
      r.verdict.status !== "invalid",
  );

function claimSentence(results) {
  const runs = counted(results, "one-in-five", CLAIM.editors);
  if (runs.length < CLAIM.minRuns) {
    return `**Not determined:** ${runs.length} runs at ${CLAIM.editors} editors, ${CLAIM.minRuns} are needed.`;
  }
  const worst = Math.max(...runs.map((r) => r.latencyMs.p95));
  if (runs.some((r) => r.verdict.status === "failed")) {
    return `**Not supported as measured:** a run at ${CLAIM.editors} editors failed (highest p95 ${fixed(worst, 1)} ms).`;
  }
  if (worst < CLAIM.p95Ms) {
    return `**The claim holds as defined:** the p95 of every one of the ${runs.length} valid runs at ${CLAIM.editors} editors is below ${CLAIM.p95Ms} ms (highest ${fixed(worst, 1)} ms).`;
  }
  return `**The claim does not hold as defined:** the highest p95 of the ${runs.length} runs at ${CLAIM.editors} editors is ${fixed(worst, 1)} ms, not below ${CLAIM.p95Ms} ms.`;
}

/** The table of every run, with its status, and the one-line verdict on the claim. */
export function renderTable(results) {
  const rows = results.map((r) => {
    const lag = Math.max(0, ...r.generator.map((g) => g.eventLoopDelayMs.p99));
    return `| \`${r.file ?? `${r.label}.json`}\` | ${scenarioOf(r)} | ${r.parameters.editors} (${r.parameters.writers} typing) | ${fixed(r.latencyMs.p50, 1)} | ${fixed(r.latencyMs.p95, 1)} | ${fixed(r.latencyMs.p99, 1)} | ${fixed(r.latencyMs.max, 1)} | ${fixed(r.server.rssMiB.windowMax, 0)} | ${fixed(r.server.cpuPercentOfOneCore.windowMean, 0)} | ${fixed(lag, 1)} | ${r.verdict.status} |`;
  });
  return [
    "| Results file | Scenario | Editors | p50 (ms) | p95 (ms) | p99 (ms) | Slowest delivery, max (ms) | Server RSS, highest (MiB) | Server CPU, mean (% of a core) | Generator lag p99, worst process (ms, includes about a millisecond of timer slop) | Status |",
    "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
    claimSentence(results),
    "",
    instrumentsLine(results),
  ].join("\n");
}

/** Whether a run's generator lag came from the timer meter (it records when the worst delay was) or from Node's histogram. */
const usedMeter = (r) => r.generator.every((g) => g.eventLoopDelayMs.maxAtMs !== undefined);

const plural = (n) => `${n} run${n === 1 ? "" : "s"}`;

/** Says which instrument measured the generator lag column, per run: the runs differ. */
function instrumentsLine(results) {
  const meter = results.filter(usedMeter).length;
  const histogram = results.length - meter;
  const meterName = "the timer meter of `apps/collab/bench/lag.ts`";
  const histogramName = "Node's event-loop histogram";
  const see = "see addendum 3 of [docs/benchmarks.md](docs/benchmarks.md)";
  if (meter > 0 && histogram > 0) {
    return `The generator lag column mixes two instruments: ${histogramName} for ${plural(histogram)} and ${meterName} for ${plural(meter)} (${see}).`;
  }
  return `The generator lag column comes from ${meter > 0 ? meterName : histogramName} for all ${plural(results.length)} (${see}).`;
}

const sizes = (results, scenario) =>
  [
    ...new Set(results.filter((r) => scenarioOf(r) === scenario).map((r) => r.parameters.editors)),
  ].sort((a, b) => a - b);

function integrityLine(results) {
  const runs = results.filter((r) => r.verdict.status !== "invalid");
  const bad = runs.filter(
    (r) =>
      r.verdict.status !== "valid" ||
      r.integrity.disconnects + r.integrity.rejections + r.integrity.refusedHandshakes > 0,
  );
  if (bad.length === 0) {
    return `In every one of the ${runs.length} counted runs nobody was disconnected, refused or sent a \`rejected\` notice, the server logged no warning, every delivery arrived exactly once, and every editor and the database ended with the same document; the default limits did not throttle these loads.`;
  }
  const names = bad
    .map(
      (r) =>
        `\`${r.file ?? r.label}\` (${[...r.verdict.invalid, ...r.verdict.failed].join("; ") || r.verdict.status})`,
    )
    .join(", ");
  return `Not every counted run was clean: ${names}.`;
}

function goalTwoLine(results) {
  const parts = [];
  for (const scenario of ["all-write", "one-in-five"]) {
    for (const editors of sizes(results, scenario)) {
      const runs = counted(results, scenario, editors);
      const typing = results.find(
        (r) => scenarioOf(r) === scenario && r.parameters.editors === editors,
      ).parameters.writers;
      const clean = runs.filter((r) => r.verdict.status === "valid").length;
      parts.push(
        `${editors} editors with ${typing} typing (${scenario}): ${clean} of ${runs.length} counted runs clean`,
      );
    }
  }
  const all = sizes(results, "all-write");
  const supported = all
    .filter((n) => n >= GOAL_TWO_MIN_EDITORS)
    .filter((n) => {
      const runs = counted(results, "all-write", n);
      return runs.length >= CLAIM.minRuns && runs.every((r) => r.verdict.status === "valid");
    });
  const head =
    supported.length > 0
      ? `**Goal 2 (${GOAL_TWO_MIN_EDITORS} or more editors on one document at once, with live cursors and presence), as measured:** supported with every editor typing, up to ${Math.max(...supported)} editors.`
      : `**Goal 2 (${GOAL_TWO_MIN_EDITORS} or more editors on one document at once, with live cursors and presence), as measured:** not supported with every editor typing by these runs.`;
  const mostOne = Math.max(0, ...sizes(results, "one-in-five"));
  const mostAll = Math.max(0, ...all);
  const gap =
    mostAll > 0 && mostOne > mostAll
      ? ` Every editor typing was not measured above ${mostAll} editors: the one-in-five runs go up to ${mostOne} editors, of whom ${
          results.find((r) => scenarioOf(r) === "one-in-five" && r.parameters.editors === mostOne)
            .parameters.writers
        } typed.`
      : "";
  return `${head} By run: ${parts.join("; ")}.${gap}`;
}

function mediansLine(results) {
  const out = [];
  for (const scenario of ["one-in-five", "all-write"]) {
    const parts = sizes(results, scenario).map((editors) => {
      const runs = counted(results, scenario, editors);
      if (runs.length === 0) return `${editors} editors: no counted run`;
      return `${editors} editors ${fixed(median(runs.map((r) => r.latencyMs.p95)), 1)} ms and ${fixed(median(runs.map((r) => r.server.cpuPercentOfOneCore.windowMean)), 0)}%`;
    });
    if (parts.length > 0) out.push(`${scenario}: ${parts.join(", ")}`);
  }
  return `Median over the counted runs of each size, p95 latency and mean server CPU as a percentage of one core: ${out.join("; ")}.`;
}

/** The slowest single delivery of any counted run, with that run's p99 and its generators' worst delay. */
function tailLine(results) {
  const runs = results.filter((r) => r.verdict.status !== "invalid");
  if (runs.length === 0) return null;
  const worst = runs.reduce((a, b) => (b.latencyMs.max > a.latencyMs.max ? b : a));
  const stall = Math.max(0, ...worst.generator.map((g) => g.eventLoopDelayMs.max));
  return `**The tail.** The slowest single delivery in a counted run took ${fixed(worst.latencyMs.max, 1)} ms (\`${worst.file ?? worst.label}\`, ${scenarioOf(worst)}, ${worst.parameters.editors} editors); that run's p99 was ${fixed(worst.latencyMs.p99, 1)} ms and the worst event-loop delay of its generator processes was ${fixed(stall, 1)} ms. The table shows the maximum of every run. The claim is judged on p95 and goal 2 on clean runs, not on the maximum.`;
}

/** The generated prose: claim, setup, scenarios, integrity, goal 2, medians, tail. */
export function renderText(results) {
  const first = results[0];
  const p = first.parameters;
  const same = (pick) => new Set(results.map((r) => JSON.stringify(pick(r)))).size === 1;
  const notes = [];
  if (!same((r) => [r.machine, r.nodeVersion, r.services])) {
    notes.push(
      "The runs were not all made on the same machine and software; see the results files.",
    );
  }
  if (
    !same((r) => [
      r.parameters.warmupSeconds,
      r.parameters.durationSeconds,
      r.parameters.drainSeconds,
      r.parameters.editsPerSecondPerWriter,
      r.parameters.readerCursorIntervalMs,
      r.parameters.server,
    ])
  ) {
    notes.push(
      "The runs did not all use the same timing, typing rate or server configuration; see the results files.",
    );
  }
  const on = (flag) => (flag ? "on" : "off");
  const k = Math.round(
    1 / (results.find((r) => scenarioOf(r) === "one-in-five")?.parameters.writerShare ?? 0.2),
  );
  const processes = (scenario) =>
    sizes(results, scenario)
      .map((n) => {
        const used = new Set(
          results
            .filter((r) => scenarioOf(r) === scenario && r.parameters.editors === n)
            .map((r) => r.parameters.generatorProcesses),
        );
        return `${n} editors on ${[...used].join(" or ")}`;
      })
      .join(", ");
  const hasAll = sizes(results, "all-write").length > 0;
  const lines = [
    `**The claim, as defined.** "Sync latency under ${CLAIM.p95Ms} ms" means: with ${CLAIM.editors} editors on one document on local loopback, the 95th percentile of the time from a client applying and sending its own edit to another client having received and applied it, over every (edit, receiving editor) pair of a run, is below ${CLAIM.p95Ms} ms in each of at least ${CLAIM.minRuns} runs.`,
    "",
    `**Setup.** One ${first.machine.cpu} machine with ${first.machine.cores} cores and ${first.machine.ramGiB} GB of RAM; the clients and the server on the loopback interface; Node ${first.nodeVersion}, PostgreSQL ${first.services.postgres.split(" ")[0]} and Redis ${first.services.redis}, all local. The server is the real collab server in ${p.server.nodeEnv} mode: ${p.server.instances} instance, Redis ${on(p.server.redisAdapter)}${p.server.redisAdapter ? " (relay, connection counters, membership channel)" : ""}, PostgreSQL persistence ${on(p.server.postgresPersistence)} (update log compacted into snapshots), and ${p.server.limits === "defaults" ? "default" : p.server.limits} limits, none raised. Every editor is its own user with one socket on the same document, with cursors and presence on. A typing editor makes ${p.editsPerSecondPerWriter} edits per second on average, one character per edit, and moves its cursor with every character; an editor that does not type moves its cursor about every ${p.readerCursorIntervalMs / 1000} seconds. Each run has ${p.warmupSeconds} seconds of warm-up, a window of ${p.durationSeconds} seconds that is measured, and ${p.drainSeconds} seconds for what is still in flight to arrive. The editors are headless (\`yjs\` and \`socket.io-client\`, speaking the real sync and awareness protocol).`,
    "",
    `**Two scenarios.** In the _one-in-five_ scenario one editor in ${k} types and the others only read: ${sizes(
      results,
      "one-in-five",
    )
      .map(
        (n) =>
          `${n} editors, ${results.find((r) => scenarioOf(r) === "one-in-five" && r.parameters.editors === n).parameters.writers} of them typing`,
      )
      .join("; ")}; generator processes: ${processes("one-in-five")}.${
      hasAll
        ? ` In the _all-write_ scenario every editor types, at the same rate and with the same cursor behaviour: ${sizes(
            results,
            "all-write",
          )
            .map((n) => `${n} editors, ${n} of them typing`)
            .join("; ")}; generator processes: ${processes("all-write")}. It was added after the ${
            results.filter((r) => scenarioOf(r) === "one-in-five").length
          } one-in-five runs, because in them only one editor in ${k} wrote; see [docs/benchmarks.md](docs/benchmarks.md).`
        : ""
    }`,
    "",
    integrityLine(results),
    "",
    goalTwoLine(results),
    "",
    mediansLine(results),
    ...(tailLine(results) ? ["", tailLine(results)] : []),
    ...(notes.length ? ["", ...notes] : []),
  ];
  return lines.join("\n");
}

/** A table without its padding: Prettier aligns columns and puts blank lines around blocks. */
export function normalizeTable(text) {
  return text
    .split("\n")
    .map((line) =>
      line.startsWith("|")
        ? line
            .split("|")
            .map((cell) => (/^\s*:?-+:?\s*$/.test(cell) ? "---" : cell.trim()))
            .join("|")
        : line.trimEnd(),
    )
    .filter((line) => line !== "")
    .join("\n");
}

const textBlock = (results) => `${TEXT_START}\n${renderText(results)}\n${TEXT_END}`;
const tableBlock = (results) => `${START}\n${renderTable(results)}\n${END}`;

function replaceBlock(readme, start, end, block, anchor) {
  const a = readme.indexOf(start);
  const b = readme.indexOf(end);
  if (a >= 0 && b > a) return readme.slice(0, a) + block + readme.slice(b + end.length);
  return readme.replace(anchor, (m) => `${m}\n${block}\n`);
}

/** The README with both generated blocks (re)written. */
export function withBlocks(readme, results) {
  const withText = replaceBlock(
    readme,
    TEXT_START,
    TEXT_END,
    textBlock(results),
    /^## Performance\n/m,
  );
  return replaceBlock(withText, START, END, tableBlock(results), new RegExp(`${TEXT_END}\\n`));
}

/** The text of the Performance section: from its heading to the next second-level heading. */
export function performanceSection(readme) {
  const match = /^## Performance\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(readme);
  return match ? match[1] : "";
}

export function checkReadme(readme, results, docs = null) {
  if (results.length === 0) return ["there are no results files"];
  const problems = [];
  const blocks = [
    [TEXT_START, TEXT_END, textBlock(results)],
    [START, END, tableBlock(results)],
  ];
  let prose = performanceSection(readme);
  for (const [start, end, expected] of blocks) {
    const a = readme.indexOf(start);
    const b = readme.indexOf(end);
    if (a < 0 || b < a) {
      problems.push(`the README has no ${start} ... ${end} block in its Performance section`);
      continue;
    }
    if (normalizeTable(readme.slice(a, b + end.length)) !== normalizeTable(expected)) {
      problems.push(
        `the block ${start} is not what the results files produce; run: node scripts/benchmarks/readme-numbers.mjs --write`,
      );
    }
    const a2 = prose.indexOf(start);
    const b2 = prose.indexOf(end);
    if (a2 >= 0 && b2 > a2) prose = prose.slice(0, a2) + prose.slice(b2 + end.length);
  }
  prose.split("\n").forEach((line, i) => {
    const digit = /\d+(?:[.,]\d+)*/.exec(line);
    if (digit)
      problems.push(`hand-written text has a number (${digit[0]}): "${line.trim().slice(0, 60)}"`);
    const word = SPELLED.exec(line);
    if (word)
      problems.push(
        `hand-written text has a spelled-out number (${word[0]}): "${line.trim().slice(0, 60)}"`,
      );
  });
  if (docs !== null) {
    for (const constant of [`${CLAIM.p95Ms} ms`, `at ${CLAIM.editors} editors`]) {
      if (!docs.includes(constant))
        problems.push(`the protocol does not contain the claim constant "${constant}"`);
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
    writeFileSync(readmePath, withBlocks(readme, results));
    console.log(`readme-numbers: wrote the blocks for ${results.length} results files`);
    return;
  }
  const problems = checkReadme(readme, results, readFileSync(arg("docs", DEFAULT_DOCS), "utf8"));
  if (problems.length > 0) {
    console.error(problems.join("\n"));
    console.error(`readme-numbers: ${problems.length} problem(s)`);
    process.exit(1);
  }
  console.log(`readme-numbers: ok (${results.length} results files)`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) main();
