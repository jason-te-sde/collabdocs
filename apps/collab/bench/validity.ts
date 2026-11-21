/**
 * The rule for an invalid run, fixed in docs/benchmarks.md before any measurement.
 *
 * "invalid": the run says nothing about the server (the generator or the machine
 * was the limit, or the clocks disagree). It is kept in the results, marked, and run again.
 * "failed": the server dropped a client, lost a delivery, refused a message or the
 * documents diverged. That is a result about the server. It is reported and not run again
 * to find a better one.
 * A run that is both is "invalid": a generator-limited run proves nothing about the server,
 * but the failure reasons are kept.
 */
export const LAG_CAP_MS = 10;

export interface RunFacts {
  latencyP95Ms: number;
  /** The 99th percentile of event-loop delay in the measured window, one entry per generator process. */
  generatorLagP99Ms: number[];
  disconnects: number;
  rejections: number;
  connectErrors: number;
  /** Warnings or errors in the server's log during the run. */
  serverWarnings: number;
  missing: number;
  duplicates: number;
  unmatched: number;
  negative: number;
  /** Editors whose final document differs from the others. */
  diverged: number;
  /** 1 when the database does not hold the document the editors ended with. */
  persistedMismatch: number;
  machineQuiet: boolean;
}

export interface Verdict {
  status: "valid" | "invalid" | "failed";
  invalid: string[];
  failed: string[];
}

export function judgeRun(facts: RunFacts): Verdict {
  const invalid: string[] = [];
  const failed: string[] = [];
  const cap = Math.min(LAG_CAP_MS, facts.latencyP95Ms);
  const worst = Math.max(0, ...facts.generatorLagP99Ms);
  if (worst > cap) {
    invalid.push(
      `generator event-loop delay p99 ${worst.toFixed(2)} ms is above ${cap.toFixed(2)} ms (the smaller of ${LAG_CAP_MS} ms and the measured p95 latency)`,
    );
  }
  if (!facts.machineQuiet) invalid.push("the machine was not quiet at the start of the run");
  if (facts.negative > 0) invalid.push(`${facts.negative} negative latencies: the clocks disagree`);
  if (facts.disconnects > 0) failed.push(`${facts.disconnects} disconnects during the run`);
  if (facts.rejections > 0) failed.push(`${facts.rejections} rejected messages`);
  if (facts.connectErrors > 0) failed.push(`${facts.connectErrors} refused handshakes`);
  if (facts.serverWarnings > 0) failed.push(`${facts.serverWarnings} server warnings or errors`);
  if (facts.missing > 0) failed.push(`${facts.missing} deliveries missing after the drain`);
  if (facts.duplicates > 0) failed.push(`${facts.duplicates} duplicate deliveries`);
  if (facts.unmatched > 0) failed.push(`${facts.unmatched} receives that match no send`);
  if (facts.diverged > 0) failed.push(`${facts.diverged} editors ended with a different document`);
  if (facts.persistedMismatch > 0) failed.push("the database does not hold the final document");
  const status = invalid.length > 0 ? "invalid" : failed.length > 0 ? "failed" : "valid";
  return { status, invalid, failed };
}
