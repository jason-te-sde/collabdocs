/**
 * The p-th percentile by the nearest-rank method: the value at rank ceil(p/100 * n)
 * of the sorted sample (rank 1 for p = 0). No interpolation, so every reported
 * percentile is a latency that was actually observed.
 */
export function percentile(values: ArrayLike<number>, p: number): number {
  if (values.length === 0) throw new Error("percentile of an empty sample");
  if (!(p >= 0 && p <= 100)) throw new Error(`percentile must be between 0 and 100, got ${p}`);
  const sorted = Float64Array.from(values).sort();
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[rank - 1]!;
}

export interface Summary {
  count: number;
  min: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
  mean: number;
}

export function summarize(values: ArrayLike<number>): Summary {
  if (values.length === 0) throw new Error("summary of an empty sample");
  const sorted = Float64Array.from(values).sort();
  const at = (p: number) => sorted[Math.max(1, Math.ceil((p / 100) * sorted.length)) - 1]!;
  let sum = 0;
  for (const value of sorted) sum += value;
  return {
    count: sorted.length,
    min: sorted[0]!,
    p50: at(50),
    p95: at(95),
    p99: at(99),
    max: sorted[sorted.length - 1]!,
    mean: sum / sorted.length,
  };
}
