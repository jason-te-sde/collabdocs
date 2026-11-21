import { describe, expect, it } from "vitest";
import { LagMeter } from "../bench/lag";

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
function block(ms: number): void {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    /* hold the event loop */
  }
}

describe("LagMeter", () => {
  it("shows a deliberate block of the event loop in max and says when it happened", async () => {
    const meter = new LagMeter(5);
    meter.start();
    await sleep(100);
    block(60);
    await sleep(100);
    const lag = meter.stop();
    expect(lag.max).toBeGreaterThan(50);
    expect(lag.max).toBeLessThan(120);
    expect(lag.maxAtMs).toBeGreaterThan(80);
    expect(lag.maxAtMs).toBeLessThan(260);
  });

  it("reports a small max for an idle loop (no start-up spike)", async () => {
    const meter = new LagMeter(5);
    meter.start();
    await sleep(400);
    const lag = meter.stop();
    expect(lag.max).toBeLessThan(10);
    expect(lag.p99).toBeLessThan(10);
    expect(lag.samples).toBeGreaterThan(20);
  });

  it("keeps nothing from before start()", async () => {
    const meter = new LagMeter(5);
    block(50);
    meter.start();
    await sleep(100);
    expect(meter.stop().max).toBeLessThan(10);
  });
});
