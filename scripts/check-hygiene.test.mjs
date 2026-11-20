import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { fileURLToPath } from "node:url";

const script = path.join(path.dirname(fileURLToPath(import.meta.url)), "check-hygiene.mjs");
const dirs = [];
after(() => dirs.forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function repo(files, messages = ["Add things"]) {
  const dir = mkdtempSync(path.join(tmpdir(), "hygiene-"));
  dirs.push(dir);
  const git = (...args) => execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.test");
  git("config", "user.name", "T");
  messages.forEach((message, index) => {
    for (const [name, content] of Object.entries(files)) {
      mkdirSync(path.dirname(path.join(dir, name)), { recursive: true });
      writeFileSync(path.join(dir, name), `${content}\n${index}\n`);
    }
    git("add", "-A");
    git("commit", "-q", "--allow-empty", "-m", message);
  });
  return dir;
}

function run(dir) {
  const result = spawnSync("node", [script, dir], { encoding: "utf8" });
  return { status: result.status, out: result.stdout };
}

test("a clean repository passes", () => {
  assert.equal(run(repo({ "a.txt": "hello" })).status, 0);
});

// Characters are written as escapes so that this file is itself clean.
const cases = [
  ["a Han character", "\u4E2D"],
  ["a Han character in an extension plane", "\u{20000}"],
  ["a Han character in extension A", "\u3400"],
  ["a hiragana character", "\u3042"],
  ["a katakana character", "\u30A2"],
  ["a Hangul character", "\uAC00"],
  ["CJK punctuation", "\u3001"],
  ["a fullwidth form", "\uFF01"],
];
for (const [name, char] of cases) {
  test(`rejects ${name} in a file`, () => {
    const result = run(repo({ "a.txt": `x ${char} y` }));
    assert.equal(result.status, 1);
    assert.match(result.out, /a\.txt:1: cjk-text/);
  });
  test(`rejects ${name} in a file name`, () => {
    const result = run(repo({ [`n${char}.txt`]: "ok" }));
    assert.equal(result.status, 1);
    assert.match(result.out, /cjk-file-name/);
  });
  test(`rejects ${name} in a commit message`, () => {
    const result = run(repo({ "a.txt": "ok" }, [`Add ${char}`]));
    assert.equal(result.status, 1);
    assert.match(result.out, /commit [0-9a-f]{40}:1: cjk-text/);
  });
}

const trailer = ["Co", "Authored", "By"].join("-");
const attribution = [
  [`${trailer}: Someone <x@example.test>`, "a co-author trailer"],
  [`${trailer.toUpperCase()}: Someone`, "a co-author trailer in upper case"],
  [["Gener", "ated with a tool"].join(""), "a generator line"],
  [["written by Cl", "aude"].join(""), "a name"],
  [["made by ANTHRO", "PIC"].join(""), "a vendor name in upper case"],
  [["ask Chat", "GPT"].join(""), "another assistant"],
  ["\u{1F916} done", "a robot emoji"],
];
for (const [text, name] of attribution) {
  test(`rejects ${name} in a file`, () => {
    const result = run(repo({ "a.txt": text }));
    assert.equal(result.status, 1);
    assert.match(result.out, /a\.txt:1: attribution/);
  });
  test(`rejects ${name} in a commit message`, () => {
    const result = run(repo({ "a.txt": "ok" }, ["Add feature", `Add more\n\n${text}`]));
    assert.equal(result.status, 1);
    assert.match(result.out, /commit [0-9a-f]{40}:3: attribution/);
  });
}

test("finds a violation in any commit of the history, not only the last", () => {
  const dir = repo({ "a.txt": "ok" }, ["first", `second\n\n${trailer}: Someone`, "third"]);
  assert.equal(run(dir).status, 1);
});

test("an untracked file is scanned too", () => {
  const dir = repo({ "a.txt": "ok" });
  writeFileSync(path.join(dir, "new.txt"), "x \u4E2D y\n");
  assert.equal(run(dir).status, 1);
});

test("a broken patterns file is an error, not a pass", () => {
  const dir = repo({ "a.txt": "ok" });
  const result = spawnSync("node", [script, dir], {
    encoding: "utf8",
    env: { ...process.env, HYGIENE_PATTERNS: path.join(dir, "missing.txt") },
  });
  assert.equal(result.status, 2);
});
