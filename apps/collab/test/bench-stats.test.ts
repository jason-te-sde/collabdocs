import { describe, expect, it } from "vitest";
import { percentile, summarize } from "../bench/stats";

describe("percentile (nearest rank)", () => {
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);

  it("is the value at rank ceil(p/100 * n) of the sorted values", () => {
    expect(percentile(hundred, 50)).toBe(50);
    expect(percentile(hundred, 95)).toBe(95);
    expect(percentile(hundred, 99)).toBe(99);
    expect(percentile(hundred, 100)).toBe(100);
  });

  it("rounds the rank up, so p95 of 10 values is the largest", () => {
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10);
    expect(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 50)).toBe(5);
  });

  it("does not need sorted input and does not modify it", () => {
    const input = [5, 1, 4, 2, 3];
    expect(percentile(input, 60)).toBe(3);
    expect(input).toEqual([5, 1, 4, 2, 3]);
  });

  it("works on typed arrays", () => {
    expect(percentile(new Float64Array([9, 1, 5]), 50)).toBe(5);
  });

  it("returns the only value of a single sample, and the minimum for p0", () => {
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([3, 1, 2], 0)).toBe(1);
  });

  it("refuses an empty sample and a percentile outside 0..100", () => {
    expect(() => percentile([], 50)).toThrow(/empty/);
    expect(() => percentile([1], 101)).toThrow(/between 0 and 100/);
    expect(() => percentile([1], -1)).toThrow(/between 0 and 100/);
  });
});

describe("summarize", () => {
  it("reports count, extremes, mean and the three percentiles", () => {
    const s = summarize([4, 1, 3, 2]);
    expect(s).toEqual({ count: 4, min: 1, p50: 2, p95: 4, p99: 4, max: 4, mean: 2.5 });
  });

  it("refuses an empty sample", () => {
    expect(() => summarize([])).toThrow(/empty/);
  });
});
