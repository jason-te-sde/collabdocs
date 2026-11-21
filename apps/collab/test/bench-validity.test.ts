import { describe, expect, it } from "vitest";
import { judgeRun, LAG_CAP_MS, type RunFacts } from "../bench/validity";

const good: RunFacts = {
  latencyP95Ms: 20,
  generatorLagP99Ms: [0.5, 1.2],
  disconnects: 0,
  rejections: 0,
  connectErrors: 0,
  serverWarnings: 0,
  missing: 0,
  duplicates: 0,
  unmatched: 0,
  negative: 0,
  diverged: 0,
  persistedMismatch: 0,
  machineQuiet: true,
};

describe("judgeRun", () => {
  it("accepts a clean run", () => {
    expect(judgeRun(good)).toEqual({ status: "valid", invalid: [], failed: [] });
  });

  it("marks a run invalid when a generator process lags more than the cap", () => {
    const verdict = judgeRun({
      ...good,
      generatorLagP99Ms: [1, LAG_CAP_MS + 0.1],
      latencyP95Ms: 400,
    });
    expect(verdict.status).toBe("invalid");
    expect(verdict.invalid[0]).toMatch(/event-loop/);
  });

  it("marks a run invalid when the generator lags more than the p95 latency it measures", () => {
    const verdict = judgeRun({ ...good, latencyP95Ms: 3, generatorLagP99Ms: [4] });
    expect(verdict.status).toBe("invalid");
  });

  it("marks a run invalid when the machine was not quiet at the start", () => {
    expect(judgeRun({ ...good, machineQuiet: false }).status).toBe("invalid");
  });

  it("marks a run invalid when the clocks disagree (a negative latency)", () => {
    expect(judgeRun({ ...good, negative: 1 }).status).toBe("invalid");
  });

  it("marks a run failed, not invalid, when the server dropped a client", () => {
    const verdict = judgeRun({ ...good, disconnects: 2 });
    expect(verdict.status).toBe("failed");
    expect(verdict.failed[0]).toMatch(/disconnect/);
  });

  it("marks a run failed on lost deliveries, rejections, warnings or divergence", () => {
    for (const patch of [
      { missing: 1 },
      { rejections: 1 },
      { connectErrors: 1 },
      { serverWarnings: 1 },
      { diverged: 1 },
      { persistedMismatch: 1 },
      { duplicates: 1 },
      { unmatched: 1 },
    ]) {
      expect(judgeRun({ ...good, ...patch }).status).toBe("failed");
    }
  });

  it("reports invalid before failed: a generator-limited run proves nothing about the server", () => {
    const verdict = judgeRun({ ...good, generatorLagP99Ms: [50], latencyP95Ms: 400, missing: 5 });
    expect(verdict.status).toBe("invalid");
    expect(verdict.failed).toEqual([expect.stringMatching(/missing/)]);
  });
});
