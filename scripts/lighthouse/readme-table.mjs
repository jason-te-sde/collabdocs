#!/usr/bin/env node
// Builds the README's Lighthouse table from the `lighthouse-reports` artifacts of
// several CI runs, so that the README never quotes a single run.
//
// Each argument is the folder of one downloaded artifact (it holds
// `.lighthouseci-desktop` and `.lighthouseci-mobile`); the folder's name is shown as the
// run id. Per run, page and preset, the median of that run's reports is taken (the
// number the CI gate looks at). The table then gives min / median / max of those
// medians across the runs, and the lowest single report.
//
// usage: node scripts/lighthouse/readme-table.mjs [--readme README.md] <artifact-dir>...
//   --readme  replaces what is between the lighthouse-table markers in that file
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

const START = "<!-- lighthouse-table:start -->";
const END = "<!-- lighthouse-table:end -->";
const PAGES = [
  ["/sign-in", "Sign-in (`/sign-in`, signed out)"],
  ["/documents", "Document list (`/documents`, signed in)"],
  ["/documents/:id", "Editor (`/documents/:id`, signed in, seeded)"],
];
const PRESETS = ["desktop", "mobile"];

const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const pageOf = (url) => {
  const { pathname } = new URL(url);
  return pathname.startsWith("/documents/") ? "/documents/:id" : pathname;
};

/** page -> preset -> one entry per run: the reports of that run. */
export function load(dirs) {
  const data = new Map();
  const versions = new Set();
  for (const dir of dirs) {
    for (const preset of PRESETS) {
      const folder = path.join(dir, `.lighthouseci-${preset}`);
      if (!existsSync(folder)) throw new Error(`${folder} is missing`);
      for (const name of readdirSync(folder)) {
        if (!/^lhr-.*\.json$/.test(name)) continue;
        const lhr = JSON.parse(readFileSync(path.join(folder, name), "utf8"));
        if (lhr.runtimeError) throw new Error(`${name}: ${lhr.runtimeError.message}`);
        if (lhr.configSettings.formFactor !== preset) {
          throw new Error(`${name}: measured ${lhr.configSettings.formFactor}, expected ${preset}`);
        }
        versions.add(lhr.lighthouseVersion);
        const page = pageOf(lhr.requestedUrl);
        const key = `${page}|${preset}`;
        const byRun = data.get(key) ?? new Map();
        const reports = byRun.get(dir) ?? [];
        reports.push({
          performance: lhr.categories.performance.score,
          accessibility: lhr.categories.accessibility.score,
          lcp: lhr.audits["largest-contentful-paint"].numericValue,
          tbt: lhr.audits["total-blocking-time"].numericValue,
          cls: lhr.audits["cumulative-layout-shift"].numericValue,
        });
        byRun.set(dir, reports);
        data.set(key, byRun);
      }
    }
  }
  return { data, versions: [...versions] };
}

export function table(dirs) {
  const { data, versions } = load(dirs);
  const spread = (values, format) =>
    [Math.min(...values), median(values), Math.max(...values)].map(format).join(" / ");
  const score = (v) => v.toFixed(2);
  const ms = (v) => `${Math.round(v)}`;
  const lines = [
    "| Page | Preset | Performance | Lowest single performance | Accessibility | LCP ms | TBT ms | CLS |",
    "| --- | --- | --- | --- | --- | --- | --- | --- |",
  ];
  for (const preset of PRESETS) {
    for (const [page, label] of PAGES) {
      const byRun = data.get(`${page}|${preset}`);
      if (!byRun || byRun.size !== dirs.length) throw new Error(`no reports for ${page} ${preset}`);
      const perRun = [...byRun.values()].map((reports) => ({
        performance: median(reports.map((r) => r.performance)),
        accessibility: median(reports.map((r) => r.accessibility)),
        lcp: median(reports.map((r) => r.lcp)),
        tbt: median(reports.map((r) => r.tbt)),
        cls: median(reports.map((r) => r.cls)),
      }));
      const lowest = Math.min(...[...byRun.values()].flat().map((r) => r.performance));
      lines.push(
        `| ${label} | ${preset} | ${spread(
          perRun.map((r) => r.performance),
          score,
        )} | ${score(lowest)} | ${spread(
          perRun.map((r) => r.accessibility),
          score,
        )} | ${spread(
          perRun.map((r) => r.lcp),
          ms,
        )} | ${spread(
          perRun.map((r) => r.tbt),
          ms,
        )} | ${spread(
          perRun.map((r) => r.cls),
          (v) => v.toFixed(3),
        )} |`,
      );
    }
  }
  const runs = dirs.map((dir) => path.basename(path.resolve(dir)));
  return { lines, versions, runs };
}

export function render(dirs, repository) {
  const { lines, versions, runs } = table(dirs);
  const links = runs.map((id) =>
    repository ? `[${id}](https://github.com/${repository}/actions/runs/${id})` : id,
  );
  return [
    `Each cell is **min / median / max** of the per-run medians across ${runs.length} runs of the same commit's \`lighthouse\` job: ${links.join(", ")}. Every per-run median is the median of three Lighthouse reports, the number the gate checks. Lighthouse ${versions.join(", ")}, presets \`desktop\` and \`mobile\` (Lighthouse's default mobile emulation, simulated throttling), Chrome on a GitHub-hosted \`ubuntu-24.04\` runner. "Lowest single performance" is the worst of all the individual reports.`,
    "",
    ...lines,
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  let readme = null;
  let repository = process.env.GITHUB_REPOSITORY ?? null;
  const dirs = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--readme") readme = args[++i];
    else if (args[i] === "--repository") repository = args[++i];
    else dirs.push(args[i]);
  }
  if (dirs.length === 0) {
    console.error(
      "usage: readme-table.mjs [--readme README.md] [--repository owner/name] <artifact-dir>...",
    );
    process.exit(2);
  }
  const text = render(dirs, repository);
  if (!readme) console.log(text);
  else {
    const file = readFileSync(readme, "utf8");
    const from = file.indexOf(START);
    const to = file.indexOf(END);
    if (from === -1 || to === -1 || to < from) {
      console.error(`${readme} has no ${START} ... ${END} block`);
      process.exit(1);
    }
    writeFileSync(readme, `${file.slice(0, from + START.length)}\n\n${text}\n\n${file.slice(to)}`);
  }
}
