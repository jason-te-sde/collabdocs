import { fork } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { estimateOffset, measureSkew } from "../bench/skew";

describe("estimateOffset", () => {
  it("takes the exchange with the shortest round trip and reports half of it as the uncertainty", () => {
    // The remote clock is 3 ms ahead. The first exchange is slow and asymmetric.
    const result = estimateOffset([
      { sent: 100, remote: 110, received: 120 },
      { sent: 200, remote: 203.2, received: 200.4 },
      { sent: 300, remote: 306, received: 310 },
    ]);
    expect(result.offsetMs).toBeCloseTo(3.0, 1);
    expect(result.uncertaintyMs).toBeCloseTo(0.2, 5);
  });

  it("refuses an empty list", () => {
    expect(() => estimateOffset([])).toThrow(/no exchange/);
  });
});

describe("measureSkew against a real second process", () => {
  it("finds the clock of another process within a fraction of a millisecond", async () => {
    const child = fork(
      path.join(path.dirname(fileURLToPath(import.meta.url)), "../bench/clock-echo.ts"),
      [],
      {
        execArgv: ["--import", "tsx"],
      },
    );
    try {
      await new Promise((resolve) => child.once("message", resolve));
      const result = await measureSkew(child, 200);
      expect(Math.abs(result.offsetMs)).toBeLessThan(0.5);
      expect(result.uncertaintyMs).toBeLessThan(1);
    } finally {
      child.kill();
    }
  }, 20_000);
});
