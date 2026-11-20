import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "readme-table.mjs");
const PAGES = ["/sign-in", "/documents", "/documents/abc"];

function report(page, preset, performance) {
  const url = `http://localhost:3000${page}`;
  return {
    requestedUrl: url,
    finalDisplayedUrl: url,
    lighthouseVersion: "13.6.0",
    configSettings: { formFactor: preset },
    categories: { performance: { score: performance }, accessibility: { score: 1 } },
    audits: {
      "largest-contentful-paint": { numericValue: 1000 },
      "total-blocking-time": { numericValue: (1 - performance) * 1000 },
      "cumulative-layout-shift": { numericValue: 0 },
    },
  };
}

/** One artifact folder; `mobileEditor` lists the three mobile editor scores of that run. */
function artifact(root, id, mobileEditor) {
  const dir = path.join(root, id);
  for (const preset of ["desktop", "mobile"]) {
    const folder = path.join(dir, `.lighthouseci-${preset}`);
    mkdirSync(folder, { recursive: true });
    let n = 0;
    for (const page of PAGES) {
      for (let i = 0; i < 3; i += 1) {
        const score = preset === "mobile" && page === "/documents/abc" ? mobileEditor[i] : 1;
        writeFileSync(
          path.join(folder, `lhr-${n++}.json`),
          JSON.stringify(report(page, preset, score)),
        );
      }
    }
  }
  return dir;
}

test("the table gives min, median and max of the per-run medians and the lowest single report", () => {
  const root = mkdtempSync(path.join(tmpdir(), "readme-table-"));
  try {
    const dirs = [
      artifact(root, "111", [0.9, 0.96, 0.97]),
      artifact(root, "222", [0.93, 0.94, 0.99]),
      artifact(root, "333", [0.8, 0.98, 0.98]),
    ];
    const result = spawnSync(process.execPath, [script, ...dirs], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    // Per-run medians 0.96, 0.94, 0.98; the worst single report is 0.8.
    const row = result.stdout.split("\n").find((l) => l.includes("Editor") && l.includes("mobile"));
    assert.match(row, /\| 0\.94 \/ 0\.96 \/ 0\.98 \| 0\.80 \|/);
    assert.match(result.stdout, /across 3 runs/);
    assert.match(result.stdout, /Lighthouse 13\.6\.0/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("--readme replaces only the marked block", () => {
  const root = mkdtempSync(path.join(tmpdir(), "readme-table-"));
  try {
    const dirs = [artifact(root, "111", [1, 1, 1])];
    const readme = path.join(root, "README.md");
    writeFileSync(
      readme,
      "before\n<!-- lighthouse-table:start -->\nold\n<!-- lighthouse-table:end -->\nafter\n",
    );
    const result = spawnSync(process.execPath, [script, "--readme", readme, ...dirs], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0, result.stderr);
    const text = readFileSync(readme, "utf8");
    assert.ok(text.startsWith("before\n<!-- lighthouse-table:start -->"));
    assert.ok(text.endsWith("<!-- lighthouse-table:end -->\nafter\n"));
    assert.ok(!text.includes("old"));
    assert.match(text, /\| Page \| Preset \|/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a missing preset folder fails instead of printing a partial table", () => {
  const root = mkdtempSync(path.join(tmpdir(), "readme-table-"));
  try {
    const dir = artifact(root, "111", [1, 1, 1]);
    rmSync(path.join(dir, ".lighthouseci-mobile"), { recursive: true });
    const result = spawnSync(process.execPath, [script, dir], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
