import { describe, expect, it } from "vitest";
import { cpuSeconds, isQuiet, parseTop } from "../bench/machine";

describe("cpuSeconds (ps time=)", () => {
  it("reads minutes:seconds.hundredths", () => {
    expect(cpuSeconds("0:01.25")).toBeCloseTo(1.25);
    expect(cpuSeconds("12:30.50")).toBeCloseTo(750.5);
  });
  it("reads hours and days", () => {
    expect(cpuSeconds("1:02:03.50")).toBeCloseTo(3723.5);
    expect(cpuSeconds("2-01:00:00")).toBeCloseTo(2 * 86400 + 3600);
  });
  it("refuses text that is not a time", () => {
    expect(() => cpuSeconds("abc")).toThrow(/cpu time/);
  });
});

const TOP = `Processes: 500 total
CPU usage: 50.00% user, 10.00% sys, 40.00% idle

PID    %CPU COMMAND
1      99.0 first-sample-only

Processes: 503 total, 5 running
Load Avg: 1.79, 1.88, 2.05
CPU usage: 16.72% user, 5.30% sys, 77.97% idle
SharedLibs: 644M resident

PID    %CPU COMMAND
533    5.2  airportd
40051  4.9  top
48322  4.5  Finder
`;

describe("parseTop", () => {
  it("uses the last sample: idle share and the busiest processes", () => {
    const sample = parseTop(TOP);
    expect(sample.idlePercent).toBeCloseTo(77.97);
    expect(sample.top).toEqual([
      { pid: 533, cpu: 5.2, command: "airportd" },
      { pid: 40051, cpu: 4.9, command: "top" },
      { pid: 48322, cpu: 4.5, command: "Finder" },
    ]);
  });
  it("refuses output it cannot read", () => {
    expect(() => parseTop("nothing here")).toThrow(/top/);
  });
});

describe("isQuiet", () => {
  const sample = (idlePercent: number, cpus: number[]) => ({
    idlePercent,
    top: cpus.map((cpu, i) => ({ pid: i + 1, cpu, command: "p" })),
  });
  it("is quiet when the machine is mostly idle and no process is busy", () => {
    expect(isQuiet(sample(78, [5, 4]), [])).toBe(true);
  });
  it("is not quiet when the machine is busy", () => {
    expect(isQuiet(sample(60, [5]), [])).toBe(false);
  });
  it("is not quiet when one other process is busy", () => {
    expect(isQuiet(sample(90, [25]), [])).toBe(false);
  });
  it("does not count the run's own processes", () => {
    expect(isQuiet(sample(90, [25]), [1])).toBe(true);
  });
});
