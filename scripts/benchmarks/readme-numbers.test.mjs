import assert from "node:assert/strict";
import { test } from "node:test";
import {
  normalizeTable,
  START,
  END,
  allowedNumbers,
  checkReadme,
  numbersIn,
  performanceSection,
  renderTable,
  withTable,
} from "./readme-numbers.mjs";

const run = (label, editors, p95, status = "valid", extra = {}) => ({
  label,
  commit: "a".repeat(40),
  dirty: false,
  nodeVersion: "v25.6.1",
  machine: { cpu: "Apple M2", cores: 8, ramGiB: 16 },
  services: { postgres: "17.10", redis: "8.10.3" },
  parameters: { editors, writers: editors / 5, generatorProcesses: 2 },
  latencyMs: { p50: 2.04, p95, p99: 20.456 },
  server: { rssMiB: { windowMax: 311.7 }, cpuPercentOfOneCore: { windowMean: 48.2 } },
  generator: [{ eventLoopDelayMs: { p99: 0.4 } }, { eventLoopDelayMs: { p99: 0.9 } }],
  verdict: { status, invalid: [], failed: [] },
  ...extra,
});

test("numbersIn finds standalone numbers, not digits inside words", () => {
  assert.deepEqual(
    numbersIn("p95 of 34.2 ms at 50 editors, 1,200 samples, Apple M2, node 25.6.1"),
    ["34.2", "50", "1200", "25.6.1"],
  );
});

test("allowedNumbers has a value as it is and rounded to a few decimals", () => {
  const allowed = allowedNumbers([run("50-run1", 50, 7.4567)]);
  for (const text of [
    "7.4567",
    "7.457",
    "7.46",
    "7.5",
    "7",
    "20.5",
    "2.0",
    "2",
    "311.7",
    "17.10",
    "25.6.1",
    "16",
  ]) {
    assert.ok(allowed.has(text), text);
  }
  assert.ok(!allowed.has("7.6"));
});

test("a README that only says what the files say passes", () => {
  const results = [run("50-run1", 50, 7.4)];
  const readme = `# T\n\n## Performance\n\nThe p95 was 7.4 ms with 50 editors on 8 cores.\n\n## Layout\n\nSee 999 things.\n`;
  assert.deepEqual(checkReadme(withTable(readme, results), results), []);
});

test("a number that no results file has is reported, with its line", () => {
  const results = [run("50-run1", 50, 7.4)];
  const readme = `## Performance\n\nThe p95 was 7.4 ms.\nIt was 12.3 ms at the end.\n`;
  const full = withTable(readme, results);
  const problems = checkReadme(full, results);
  assert.equal(problems.length, 1);
  assert.match(problems[0], /12\.3/);
  const line = full.split("\n").findIndex((l) => l.includes("12.3")) + 1;
  assert.match(problems[0], new RegExp(`line ${line}:`));
});

test("numbers outside the Performance section are not checked", () => {
  const results = [run("50-run1", 50, 7.4)];
  const readme = `## Performance\n\nok 7.4\n\n## Other\n\n12345 is fine here\n`;
  assert.deepEqual(checkReadme(withTable(readme, results), results), []);
  assert.equal(performanceSection(readme).includes("12345"), false);
});

test("a table that differs from the one the results produce is reported", () => {
  const results = [run("50-run1", 50, 7.4)];
  const readme = withTable(`## Performance\n\ntext\n`, results).replace("7.4", "7.3");
  const problems = checkReadme(readme, results);
  assert.ok(
    problems.some((p) => /table/.test(p)),
    problems.join("\n"),
  );
});

test("a README without the table markers is reported", () => {
  const problems = checkReadme(`## Performance\n\ntext\n`, [run("50-run1", 50, 7.4)]);
  assert.ok(problems.some((p) => p.includes(START)));
});

test("no results files is a problem, not a pass", () => {
  assert.ok(checkReadme(`## Performance\n${START}\n${END}\n`, []).length > 0);
});

test("the table has one row per run, with its status, and says whether the claim holds", () => {
  const table = renderTable([
    run("50-run1", 50, 7.4),
    run("50-run2", 50, 8.1),
    run("50-run3", 50, 9.9),
    run("100-run1", 100, 30),
    run("200-run1", 200, 700, "failed"),
  ]);
  assert.match(table, /50-run1/);
  assert.match(table, /\| failed \|/);
  assert.match(table, /holds/i);
  assert.match(table, /9\.9/);
});

test("the claim does not hold with fewer than three runs, a slow run or a failed run", () => {
  const holds = (runs) => /does not hold|not supported|not determined/i.test(renderTable(runs));
  assert.equal(holds([run("50-run1", 50, 7), run("50-run2", 50, 8)]), true);
  assert.equal(
    holds([run("50-run1", 50, 7), run("50-run2", 50, 8), run("50-run3", 50, 101)]),
    true,
  );
  assert.equal(
    holds([run("50-run1", 50, 7), run("50-run2", 50, 8), run("50-run3", 50, 9, "failed")]),
    true,
  );
  assert.equal(holds([run("50-run1", 50, 7), run("50-run2", 50, 8), run("50-run3", 50, 9)]), false);
});

test("an invalid run is shown but does not count towards the claim", () => {
  const table = renderTable([
    run("50-run1", 50, 7),
    run("50-run2", 50, 8),
    run("50-run3", 50, 9),
    run("50-run4", 50, 400, "invalid"),
  ]);
  assert.match(table, /\| invalid \|/);
  assert.match(table, /holds/i);
  assert.doesNotMatch(table, /does not hold/i);
});

test("column padding added by a formatter is not a difference", () => {
  const results = [run("50-run1", 50, 7.4)];
  const readme = withTable("## Performance\n\ntext\n", results);
  const padded = readme
    .split("\n")
    .map((line) =>
      line.startsWith("|")
        ? line.replaceAll(" | ", "     |   ").replace(/-{3,}/g, "----------")
        : line,
    )
    .join("\n");
  assert.notEqual(padded, readme);
  assert.deepEqual(checkReadme(padded, results), []);
  assert.equal(normalizeTable(padded), normalizeTable(readme));
});
