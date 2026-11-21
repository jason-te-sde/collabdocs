import { describe, expect, it } from "vitest";
import { LagMeter, type Lag } from "../bench/lag";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function block(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* hold the event loop */
  }
}

/**
 * Measures, and measures again (up to `tries` times) while a result is over its upper
 * bounds. A lower bound is a fact: a loop held for 60 ms reads at least that, on any
 * machine. An upper bound only says that the meter does not invent lag, and a loaded
 * runner adds stalls of its own, which the meter reports correctly; so an overshoot is
 * taken again instead of failing the build.
 */
async function measured(
  measure: () => Promise<Lag>,
  withinUpperBounds: (lag: Lag) => boolean,
  tries = 5,
): Promise<Lag> {
  let lag = await measure();
  for (let attempt = 1; attempt < tries && !withinUpperBounds(lag); attempt += 1) {
    lag = await measure();
  }
  return lag;
}

describe("LagMeter", () => {
  it("shows a deliberate block of the event loop in max and says when it happened", async () => {
    const lag = await measured(
      async () => {
        const meter = new LagMeter(5);
        meter.start();
        await sleep(100);
        block(60);
        await sleep(100);
        return meter.stop();
      },
      (l) => l.max < 120 && l.maxAtMs < 260,
    );
    expect(lag.max).toBeGreaterThan(50);
    expect(lag.max).toBeLessThan(120);
    expect(lag.maxAtMs).toBeGreaterThan(80);
    expect(lag.maxAtMs).toBeLessThan(260);
  });

  it("reports a small max for an idle loop (no start-up spike)", async () => {
    const lag = await measured(
      async () => {
        const meter = new LagMeter(5);
        meter.start();
        await sleep(400);
        return meter.stop();
      },
      (l) => l.max < 10 && l.p99 < 10,
    );
    expect(lag.max).toBeLessThan(10);
    expect(lag.p99).toBeLessThan(10);
    expect(lag.samples).toBeGreaterThan(20);
  });

  it("keeps nothing from before start()", async () => {
    const lag = await measured(
      async () => {
        const meter = new LagMeter(5);
        block(50);
        meter.start();
        await sleep(100);
        return meter.stop();
      },
      (l) => l.max < 10,
    );
    expect(lag.max).toBeLessThan(10);
  });
});
