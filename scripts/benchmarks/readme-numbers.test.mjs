import assert from "node:assert/strict";
import { test } from "node:test";
import {
  END,
  GOAL_TWO_MIN_EDITORS,
  START,
  TEXT_END,
  TEXT_START,
  checkReadme,
  normalizeTable,
  renderTable,
  renderText,
  withBlocks,
} from "./readme-numbers.mjs";

const run = (
  label,
  editors,
  p95,
  status = "valid",
  { share = 0.2, extra = {}, max = 55.5, meter = false } = {},
) => ({
  label,
  commit: "a".repeat(40),
  dirty: false,
  nodeVersion: "v25.6.1",
  machine: { cpu: "Apple M2", cores: 8, ramGiB: 16 },
  services: { postgres: "17.10 (Homebrew)", redis: "8.10.3" },
  parameters: {
    editors,
    writers: Math.round(editors * share),
    writerShare: share,
    generatorProcesses: 2,
    editsPerSecondPerWriter: 3,
    readerCursorIntervalMs: 5000,
    warmupSeconds: 10,
    durationSeconds: 60,
    drainSeconds: 5,
    server: {
      nodeEnv: "production",
      redisAdapter: true,
      postgresPersistence: true,
      limits: "defaults",
      instances: 1,
    },
  },
  latencyMs: { p50: 2.04, p95, p99: 20.456, max },
  server: { rssMiB: { windowMax: 311.7 }, cpuPercentOfOneCore: { windowMean: 48.2 } },
  generator: [
    { eventLoopDelayMs: { p99: 0.4, max: 3.2, ...(meter ? { maxAtMs: 1000 } : {}) } },
    { eventLoopDelayMs: { p99: 0.9, max: 7.77, ...(meter ? { maxAtMs: 2000 } : {}) } },
  ],
  integrity: { disconnects: 0, rejections: 0, refusedHandshakes: 0 },
  verdict: { status, invalid: [], failed: [] },
  ...extra,
});

const DOCS = "p95 is below 100 ms at 50 editors";
const base = [
  run("50-run1", 50, 7.4),
  run("50-run2", 50, 8.1),
  run("50-run3", 50, 9.9),
  run("100-run1", 100, 30),
  run("allwrite-50-run1", 50, 11, "valid", { share: 1 }),
  run("allwrite-50-run2", 50, 12, "valid", { share: 1 }),
  run("allwrite-50-run3", 50, 13, "valid", { share: 1 }),
];
const readme = (results = base) =>
  withBlocks("# T\n\n## Performance\n\nSee the protocol.\n\n## Layout\n\nx 42\n", results);

test("a README made from the results passes, and numbers outside the section are not looked at", () => {
  assert.deepEqual(checkReadme(readme(), base, DOCS), []);
});

test("mutation: a parameter changed in the generated text fails (warm-up, rate, editors, versions)", () => {
  const good = readme();
  for (const [from, to] of [
    ["10 seconds of warm-up", "60 seconds of warm-up"],
    ["3 edits per second", "30 edits per second"],
    ["with 50 editors on one document", "with 200 editors on one document"],
    ["Redis 8.10.3", "Redis 8.10.4"],
    ["8 cores", "16 cores"],
    ["one editor in 5 types", "one editor in 2 types"],
    ["at least 3 runs", "at least 5 runs"],
  ]) {
    assert.ok(good.includes(from), from);
    const problems = checkReadme(good.replace(from, to), base, DOCS);
    assert.ok(problems.length > 0, `${from} -> ${to} was not caught`);
  }
});

test("mutation: a table cell or the verdict sentence changed fails", () => {
  const good = readme();
  assert.ok(checkReadme(good.replace("| 7.4 ", "| 6.1 "), base, DOCS).length > 0);
  assert.ok(
    checkReadme(good.replace("(highest 9.9 ms)", "(highest 5.2 ms)"), base, DOCS).length > 0,
  );
});

test("a number or a spelled-out number in the hand-written text fails", () => {
  const good = readme();
  assert.ok(
    checkReadme(good.replace("See the protocol.", "See the protocol, 3 runs."), base, DOCS).length >
      0,
  );
  assert.ok(
    checkReadme(good.replace("See the protocol.", "Three runs were made."), base, DOCS).length > 0,
  );
  assert.ok(
    checkReadme(good.replace("See the protocol.", "Every fifth editor types."), base, DOCS).length >
      0,
  );
});

test("the results files decide: a changed file makes an unchanged README fail", () => {
  const changed = base.map((r) =>
    r.label === "50-run1" ? { ...r, latencyMs: { ...r.latencyMs, p95: 7.5 } } : r,
  );
  assert.ok(checkReadme(readme(), changed, DOCS).length > 0);
});

test("the blocks must exist", () => {
  const problems = checkReadme("## Performance\n\ntext\n", base, DOCS);
  assert.ok(problems.some((p) => p.includes(TEXT_START)));
  assert.ok(problems.some((p) => p.includes(START)));
});

test("no results files is a problem, not a pass", () => {
  assert.ok(checkReadme(`## Performance\n${START}\n${END}\n`, [], DOCS).length > 0);
});

test("the protocol must contain the claim constants", () => {
  assert.ok(checkReadme(readme(), base, "nothing here").length > 0);
});

test("column padding added by a formatter is not a difference", () => {
  const padded = readme()
    .split("\n")
    .map((line) =>
      line.startsWith("|")
        ? line.replaceAll(" | ", "     |   ").replace(/-{3,}/g, "----------")
        : line,
    )
    .join("\n");
  assert.notEqual(padded, readme());
  assert.deepEqual(checkReadme(padded, base, DOCS), []);
  assert.equal(normalizeTable(padded), normalizeTable(readme()));
});

test("the text says how many editors type, in each scenario", () => {
  const text = renderText(base);
  assert.match(text, /50 editors, 10 of them typing/);
  assert.match(text, /50 editors, 50 of them typing/);
  assert.match(renderTable(base), /50 \(10 typing\)/);
  assert.match(renderTable(base), /50 \(50 typing\)/);
});

/** The one-line verdict on the claim, which follows the table. */
const verdictOf = (runs) =>
  renderTable(runs)
    .split("\n")
    .find((line) => line.startsWith("**"));

test("the claim does not hold with fewer than three runs, a slow run or a failed run", () => {
  const verdict = verdictOf;
  assert.match(verdict([run("50-run1", 50, 7), run("50-run2", 50, 8)]), /Not determined/);
  assert.match(verdict([run("a", 50, 7), run("b", 50, 8), run("c", 50, 101)]), /does not hold/);
  assert.match(
    verdict([run("a", 50, 7), run("b", 50, 8), run("c", 50, 9, "failed")]),
    /Not supported/,
  );
  assert.match(verdict([run("a", 50, 7), run("b", 50, 8), run("c", 50, 9)]), /holds as defined/);
});

test("an invalid run is shown but does not count; all-write runs do not count towards the claim", () => {
  const runs = [
    run("a", 50, 7),
    run("b", 50, 8),
    run("c", 50, 9),
    run("d", 50, 400, "invalid"),
    run("e", 50, 900, "valid", { share: 1 }),
  ];
  const last = verdictOf(runs);
  assert.match(last, /holds as defined/);
  assert.match(renderTable(runs), /\| invalid \|/);
});

test("goal 2 is supported only by clean all-write runs of at least 50 editors", () => {
  const without = base.filter((r) => r.parameters.writerShare !== 1);
  assert.match(renderText(without), /not supported with every editor typing/);
  assert.match(renderText(base), /supported with every editor typing, up to 50 editors/);
  const failing = base.map((r) =>
    r.label === "allwrite-50-run3"
      ? { ...r, verdict: { status: "failed", invalid: [], failed: ["x"] } }
      : r,
  );
  assert.match(renderText(failing), /not supported with every editor typing/);
});

test("an unclean run is named in the text", () => {
  const failing = base.map((r) =>
    r.label === "50-run1"
      ? { ...r, verdict: { status: "failed", invalid: [], failed: ["2 disconnects"] } }
      : r,
  );
  assert.match(renderText(failing), /Not every counted run was clean/);
});

test("the table shows the slowest delivery of every run, and the text names the slowest of all", () => {
  const runs = [
    run("50-run1", 50, 7, "valid", { max: 12.34 }),
    run("50-run2", 50, 8, "valid", { max: 99.96 }),
    run("50-run3", 50, 9, "valid", { max: 40 }),
    run("allwrite-50-run1", 50, 11, "valid", { share: 1, max: 141.49 }),
    run("50-run9", 50, 9, "invalid", { max: 900 }),
  ];
  const table = renderTable(runs);
  assert.match(table, /Slowest delivery, max \(ms\)/);
  for (const shown of ["12.3", "100.0", "40.0", "141.5", "900.0"]) {
    assert.ok(table.includes(`| ${shown} |`), shown);
  }
  const tail = renderText(runs)
    .split("\n")
    .find((line) => line.startsWith("**The tail.**"));
  assert.ok(tail, "the text has a tail paragraph");
  // The slowest of the counted runs; the invalid run is shown in the table but not counted.
  assert.match(tail, /took 141\.5 ms \(`allwrite-50-run1`, all-write, 50 editors\)/);
  assert.match(tail, /p99 was 20\.5 ms/);
  assert.match(tail, /generator processes was 7\.8 ms/);
  // A changed maximum in a results file makes an unchanged README fail.
  const changed = runs.map((r) =>
    r.label === "50-run2" ? { ...r, latencyMs: { ...r.latencyMs, max: 98 } } : r,
  );
  const good = withBlocks("# T\n\n## Performance\n\nSee the protocol.\n", runs);
  assert.deepEqual(checkReadme(good, runs, DOCS), []);
  assert.ok(checkReadme(good, changed, DOCS).length > 0);
});

test("the text derives how many runs preceded the all-write scenario instead of naming a number", () => {
  const four = [
    run("50-run1", 50, 7),
    run("50-run2", 50, 8),
    run("50-run3", 50, 9),
    run("100-run1", 100, 9),
    run("allwrite-50-run1", 50, 11, "valid", { share: 1 }),
  ];
  assert.match(
    renderText(four),
    /added after the 4 one-in-five runs, because in them only one editor in 5 wrote/,
  );
  assert.match(renderText(base), /added after the 4 one-in-five runs/);
  const text = renderText([...four, run("200-run1", 200, 12)]);
  assert.match(text, /added after the 5 one-in-five runs/);
  assert.doesNotMatch(text, /nine|review/i);
});

test("it says plainly that every editor typing was not measured above the all-write sizes", () => {
  const withLarger = [...base, run("200-run1", 200, 12)];
  assert.match(
    renderText(withLarger),
    /Every editor typing was not measured above 50 editors: the one-in-five runs go up to 200 editors, of whom 40 typed\./,
  );
  // With nothing larger than the all-write runs, there is nothing to say.
  assert.doesNotMatch(
    renderText(base.filter((r) => r.parameters.editors <= 50)),
    /was not measured above/,
  );
});

test("it says which instrument measured the generator lag, run by run", () => {
  const mixed = [
    run("50-run1", 50, 7),
    run("50-run2", 50, 8),
    run("50-run3", 50, 9),
    run("allwrite-50-run1", 50, 11, "valid", { share: 1, meter: true }),
  ];
  assert.match(
    renderTable(mixed),
    /mixes two instruments: Node's event-loop histogram for 3 runs and the timer meter of `apps\/collab\/bench\/lag\.ts` for 1 run \(/,
  );
  assert.match(renderTable(base), /comes from Node's event-loop histogram for all 7 runs/);
  assert.match(
    renderTable(base.map((r) => run(r.label, r.parameters.editors, 7, "valid", { meter: true }))),
    /comes from the timer meter of `apps\/collab\/bench\/lag\.ts` for all 7 runs/,
  );
});

test("goal 2's minimum size is a constant of its own, and the text is built from it", () => {
  assert.equal(typeof GOAL_TWO_MIN_EDITORS, "number");
  assert.match(
    renderText(base),
    new RegExp(`Goal 2 \\(${GOAL_TWO_MIN_EDITORS} or more editors on one document at once`),
  );
});

test("the setup names what Redis does, not an adapter", () => {
  const text = renderText(base);
  assert.match(text, /Redis on \(relay, connection counters, membership channel\)/);
  assert.doesNotMatch(text, /adapter/i);
});
