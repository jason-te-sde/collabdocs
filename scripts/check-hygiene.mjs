#!/usr/bin/env node
// Repository hygiene check.
//
// usage: node scripts/check-hygiene.mjs [root]
//
// Fails when a file name, a file, or a commit message in the history of HEAD
// contains CJK text (any Unicode plane), or when a file or a commit message
// matches an attribution pattern. Patterns are JavaScript regular expressions,
// one per line, matched case-insensitively, in scripts/attribution-patterns.txt
// (override with HYGIENE_PATTERNS). That file is not scanned for patterns, only
// for CJK.
//
// Output: "hygiene: ok", or one "where:line: rule" line per violation.
// Exit status: 0 clean, 1 violations, 2 the check itself could not run.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(process.argv[2] ?? ".");
const patternsFile = path.resolve(
  process.env.HYGIENE_PATTERNS ?? path.join(here, "attribution-patterns.txt"),
);

// Han (all planes, including the extension blocks), kana, Hangul, Bopomofo, CJK
// radicals and symbols, CJK punctuation, enclosed CJK and fullwidth forms.
const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Script=Bopomofo}\u2E80-\u2FDF\u3000-\u303F\u3200-\u33FF\uFF00-\uFFEF]/u;

function fail(message) {
  console.error(`hygiene: ${message}`);
  process.exit(2);
}

function git(...args) {
  try {
    return execFileSync("git", ["-C", root, ...args], { encoding: "buffer", maxBuffer: 1 << 28 });
  } catch (error) {
    return fail(`git ${args.join(" ")} failed: ${error.message}`);
  }
}

let patterns;
try {
  patterns = readFileSync(patternsFile, "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => new RegExp(line, "iu"));
} catch (error) {
  fail(`cannot read the patterns file ${patternsFile}: ${error.message}`);
}
if (patterns.length < 5) fail(`the patterns file has fewer than 5 patterns: ${patternsFile}`);

const violations = [];
const report = (where, line, rule) => violations.push(`${where}:${line}: ${rule}`);

function scanText(where, text, { withPatterns }) {
  text.split("\n").forEach((line, index) => {
    if (CJK.test(line)) report(where, index + 1, "cjk-text");
    if (withPatterns && patterns.some((pattern) => pattern.test(line)))
      report(where, index + 1, "attribution");
  });
}

// Tracked files plus new files that are not ignored, so a local run sees what a commit would add.
const names = [
  ...git("ls-files", "-z").toString("utf8").split("\0"),
  ...git("ls-files", "-z", "--others", "--exclude-standard").toString("utf8").split("\0"),
].filter((name) => name !== "");

for (const name of new Set(names)) {
  if (CJK.test(name)) report(name, 0, "cjk-file-name");
  const absolute = path.join(root, name);
  let data;
  try {
    data = readFileSync(absolute);
  } catch {
    continue; // deleted in the working tree, or a submodule
  }
  if (data.subarray(0, 8000).includes(0)) continue; // binary
  scanText(name, data.toString("utf8"), { withPatterns: absolute !== patternsFile });
}

let commits = [];
try {
  execFileSync("git", ["-C", root, "rev-parse", "--verify", "--quiet", "HEAD"], {
    stdio: "ignore",
  });
  commits = git("rev-list", "HEAD").toString("utf8").split("\n").filter(Boolean);
} catch {
  // A repository without commits has no history to scan.
}
for (const sha of commits) {
  scanText(`commit ${sha}`, git("show", "-s", "--format=%B", sha).toString("utf8"), {
    withPatterns: true,
  });
}

if (violations.length > 0) {
  console.log(violations.join("\n"));
  console.error(`hygiene: ${violations.length} violation(s)`);
  process.exit(1);
}
console.log("hygiene: ok");
