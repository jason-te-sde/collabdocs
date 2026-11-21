import { describe, expect, it } from "vitest";
import { joinLatencies } from "../bench/join";

// Sends: [writerClientId, clock, sentAtMs]. Receives: [receiverIndex, writerClientId, clock, receivedAtMs].
const sends = (rows: number[][]) => Float64Array.from(rows.flat());

describe("joinLatencies", () => {
  it("pairs every receive with the send of the same writer and clock", () => {
    const result = joinLatencies({
      sends: sends([
        [100, 1, 1000],
        [100, 2, 1100],
      ]),
      receives: sends([
        [0, 100, 1, 1004],
        [1, 100, 1, 1010],
        [0, 100, 2, 1103],
        [1, 100, 2, 1109],
      ]),
      receivers: 3, // the writer and two readers; the writer does not receive its own edit
      window: { from: 0, to: 5000 },
    });
    expect(Array.from(result.latencies).sort((a, b) => a - b)).toEqual([3, 4, 9, 10]);
    expect(result.edits).toBe(2);
    expect(result.expected).toBe(4);
    expect(result.observed).toBe(4);
    expect(result.missing).toBe(0);
    expect(result.duplicates).toBe(0);
    expect(result.unmatched).toBe(0);
  });

  it("counts deliveries that never arrived", () => {
    const result = joinLatencies({
      sends: sends([[100, 1, 1000]]),
      receives: sends([[0, 100, 1, 1004]]),
      receivers: 3,
      window: { from: 0, to: 5000 },
    });
    expect(result.expected).toBe(2);
    expect(result.observed).toBe(1);
    expect(result.missing).toBe(1);
  });

  it("only measures edits sent inside the window; the others are warm-up", () => {
    const result = joinLatencies({
      sends: sends([
        [100, 1, 500],
        [100, 2, 1500],
        [100, 3, 2500],
      ]),
      receives: sends([
        [0, 100, 1, 505],
        [0, 100, 2, 1505],
        [0, 100, 3, 2505],
      ]),
      receivers: 2,
      window: { from: 1000, to: 2000 },
    });
    expect(result.edits).toBe(1);
    expect(Array.from(result.latencies)).toEqual([5]);
    expect(result.missing).toBe(0);
  });

  it("counts a delivery received twice by the same receiver as a duplicate, once as a sample", () => {
    const result = joinLatencies({
      sends: sends([[100, 1, 1000]]),
      receives: sends([
        [0, 100, 1, 1004],
        [0, 100, 1, 1050],
      ]),
      receivers: 2,
      window: { from: 0, to: 5000 },
    });
    expect(Array.from(result.latencies)).toEqual([4]);
    expect(result.duplicates).toBe(1);
  });

  it("counts a receive that matches no send as unmatched", () => {
    const result = joinLatencies({
      sends: sends([[100, 1, 1000]]),
      receives: sends([
        [0, 100, 1, 1004],
        [0, 200, 7, 1004],
      ]),
      receivers: 2,
      window: { from: 0, to: 5000 },
    });
    expect(result.unmatched).toBe(1);
    expect(result.observed).toBe(1);
  });

  it("reports a negative latency as a clock error instead of hiding it", () => {
    const result = joinLatencies({
      sends: sends([[100, 1, 1000]]),
      receives: sends([[0, 100, 1, 999]]),
      receivers: 2,
      window: { from: 0, to: 5000 },
    });
    expect(result.negative).toBe(1);
  });

  it("refuses arrays whose length is not a whole number of rows", () => {
    expect(() =>
      joinLatencies({
        sends: new Float64Array(2),
        receives: new Float64Array(4),
        receivers: 2,
        window: { from: 0, to: 1 },
      }),
    ).toThrow(/rows/);
  });
});
