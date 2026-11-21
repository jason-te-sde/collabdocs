import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "summarize.mjs");
const EDITOR = "http://localhost:3000/documents/abc123";
const MARK = { name: "collabdocs:synced", timingType: "Mark", startTime: 900 };

/** A report as `lhci collect` writes it, reduced to what summarize.mjs reads. */
function report(overrides = {}) {
  return {
    requestedUrl: EDITOR,
    finalDisplayedUrl: EDITOR,
    lighthouseVersion: "13.6.0",
    configSettings: { formFactor: "desktop" },
    categories: { performance: { score: 1 }, accessibility: { score: 1 } },
    audits: {
      "largest-contentful-paint": { numericValue: 300 },
      "total-blocking-time": { numericValue: 0 },
      "cumulative-layout-shift": { numericValue: 0 },
      "user-timings": { details: { items: [MARK] } },
    },
    ...overrides,
  };
}

function run(reports) {
  const dir = mkdtempSync(path.join(tmpdir(), "summarize-test-"));
  try {
    reports.forEach((lhr, index) =>
      writeFileSync(path.join(dir, `lhr-${index}.json`), JSON.stringify(lhr)),
    );
    return spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a good report passes and is summarised", () => {
  const result = run([report(), report()]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /\/documents\/:id/);
});

test("a report with a runtimeError fails the job", () => {
  const broken = report({
    runtimeError: { code: "ERRORED_DOCUMENT_REQUEST", message: "Page could not be loaded" },
    categories: { performance: { score: null }, accessibility: { score: null } },
    audits: {},
  });
  const result = run([report(), broken]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /could not measure the page \(ERRORED_DOCUMENT_REQUEST/);
});

test("a redirect to another page fails the job", () => {
  const result = run([
    report({ finalDisplayedUrl: "http://localhost:3000/sign-in?callbackUrl=%2Fdocuments" }),
  ]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /not the page that was asked for/);
});

test("a missing score fails the job", () => {
  const result = run([report({ categories: { performance: { score: null }, accessibility: {} } })]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /no performance or accessibility score/);
});

test("an editor scored without the synced mark fails the job", () => {
  for (const items of [[], [{ name: "something-else", timingType: "Mark", startTime: 1 }]]) {
    const lhr = report();
    lhr.audits["user-timings"] = { details: { items } };
    const result = run([lhr]);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /scored without its socket synced/);
  }
  const lhr = report();
  delete lhr.audits["user-timings"];
  assert.equal(run([lhr]).status, 1);
});

test("the mark is required of the editor page only", () => {
  const lhr = report({
    requestedUrl: "http://localhost:3000/documents",
    finalDisplayedUrl: "http://localhost:3000/documents",
  });
  lhr.audits["user-timings"] = { details: { items: [] } };
  assert.equal(run([lhr]).status, 0);
});
