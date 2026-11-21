import assert from "node:assert/strict";
import { test } from "node:test";
import {
  END,
  START,
  TEXT_END,
  TEXT_START,
  checkReadme,
  normalizeTable,
  renderTable,
  renderText,
  withBlocks,
} from "./readme-numbers.mjs";

const run = (label, editors, p95, status = "valid", { share = 0.2, extra = {} } = {}) => ({
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
  latencyMs: { p50: 2.04, p95, p99: 20.456 },
  server: { rssMiB: { windowMax: 311.7 }, cpuPercentOfOneCore: { windowMean: 48.2 } },
  generator: [{ eventLoopDelayMs: { p99: 0.4 } }, { eventLoopDelayMs: { p99: 0.9 } }],
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

test("the claim does not hold with fewer than three runs, a slow run or a failed run", () => {
  const verdict = (runs) => renderTable(runs).split("\n").at(-1);
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
  const last = renderTable(runs).split("\n").at(-1);
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
