import { execFileSync } from "node:child_process";
import os from "node:os";

/** Seconds of CPU time from the `time=` column of `ps`: [[dd-]hh:]mm:ss[.cc]. */
export function cpuSeconds(text: string): number {
  const match = /^\s*(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)\s*$/.exec(text);
  if (!match) throw new Error(`cannot read a cpu time from "${text}"`);
  const [, days, hours, minutes, seconds] = match;
  return (
    Number(days ?? 0) * 86400 + Number(hours ?? 0) * 3600 + Number(minutes) * 60 + Number(seconds)
  );
}

export interface TopSample {
  idlePercent: number;
  top: Array<{ pid: number; cpu: number; command: string }>;
}

/** Reads the last sample of `top -l 2`: the share of idle CPU and the busiest processes. */
export function parseTop(text: string): TopSample {
  const blocks = text.split(/^Processes:/m);
  const last = blocks[blocks.length - 1] ?? "";
  const idle = /([\d.]+)% idle/.exec(last);
  const header = last.indexOf("COMMAND");
  if (blocks.length < 2 || !idle || header < 0) throw new Error("cannot read the output of top");
  const top: TopSample["top"] = [];
  for (const line of last.slice(header).split("\n").slice(1)) {
    const row = /^\s*(\d+)\s+([\d.]+)\s+(.*?)\s*$/.exec(line);
    if (row) top.push({ pid: Number(row[1]), cpu: Number(row[2]), command: row[3]! });
  }
  return { idlePercent: Number(idle[1]), top };
}

/** The thresholds are fixed in docs/benchmarks.md. */
export const QUIET_MIN_IDLE_PERCENT = 70;
export const QUIET_MAX_PROCESS_PERCENT = 20;

/** Quiet: the machine is mostly idle and no process outside the run is busy. */
export function isQuiet(sample: TopSample, ownPids: number[]): boolean {
  if (sample.idlePercent < QUIET_MIN_IDLE_PERCENT) return false;
  return !sample.top.some((p) => !ownPids.includes(p.pid) && p.cpu >= QUIET_MAX_PROCESS_PERCENT);
}

export function sampleTop(): TopSample {
  const out = execFileSync(
    "top",
    ["-l", "2", "-n", "8", "-o", "cpu", "-stats", "pid,cpu,command", "-s", "2"],
    {
      encoding: "utf8",
    },
  );
  return parseTop(out);
}

/** Waits until the machine is quiet, for at most `maxWaitMs`; returns what it saw. */
export async function waitForQuiet(
  maxWaitMs: number,
): Promise<{ quiet: boolean; waitedMs: number; sample: TopSample }> {
  const start = Date.now();
  for (;;) {
    const sample = sampleTop();
    const waitedMs = Date.now() - start;
    if (isQuiet(sample, [process.pid])) return { quiet: true, waitedMs, sample };
    if (waitedMs >= maxWaitMs) return { quiet: false, waitedMs, sample };
    await new Promise((resolve) => setTimeout(resolve, 15_000));
  }
}

function run(command: string, args: string[]): string {
  return execFileSync(command, args, { encoding: "utf8" }).trim();
}

export interface Provenance {
  commit: string;
  dirty: boolean;
  nodeVersion: string;
  machine: { cpu: string; cores: number; ramGiB: number; platform: string };
  loadAverage: { m1: number; m5: number; m15: number };
}

/**
 * Where a result came from. The tree counts as dirty if anything outside the
 * results folder differs from the commit, because the results folder fills up
 * as the runs are made.
 */
export function provenance(repoRoot: string, resultsDirRelative: string): Provenance {
  const git = (...args: string[]) => run("git", ["-C", repoRoot, ...args]);
  const [m1, m5, m15] = os.loadavg() as [number, number, number];
  return {
    commit: git("rev-parse", "HEAD"),
    dirty: git("status", "--porcelain", "--", ".", `:(exclude)${resultsDirRelative}`) !== "",
    nodeVersion: process.version,
    machine: {
      cpu: run("sysctl", ["-n", "machdep.cpu.brand_string"]),
      cores: os.cpus().length,
      ramGiB: Math.round(os.totalmem() / 2 ** 30),
      platform: `${os.type()} ${os.release()} ${os.arch()}`,
    },
    loadAverage: { m1, m5, m15 },
  };
}

/** Resident memory (KiB) and cumulative CPU seconds of one process, from `ps`. */
export function processUsage(pid: number): { rssKiB: number; cpuSeconds: number } {
  const out = run("ps", ["-o", "rss=,time=", "-p", String(pid)]);
  const match = /^\s*(\d+)\s+(\S+)\s*$/.exec(out);
  if (!match) throw new Error(`cannot read the usage of process ${pid}: "${out}"`);
  return { rssKiB: Number(match[1]), cpuSeconds: cpuSeconds(match[2]!) };
}
