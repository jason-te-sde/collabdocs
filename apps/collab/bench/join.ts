/**
 * Joins what the writers logged with what the receivers logged.
 *
 * A send is [writerClientId, clock, sentAtMs]: the writer's Yjs clock after the edit
 * identifies the edit. A receive is [receiverIndex, writerClientId, clock, receivedAtMs].
 * Times are `performance.timeOrigin + performance.now()`, comparable across processes.
 * Only edits sent inside the window are measured; the rest is warm-up.
 */
export interface JoinInput {
  sends: Float64Array;
  receives: Float64Array;
  /** Everyone who should see an edit: all editors; the writer itself does not receive its own. */
  receivers: number;
  window: { from: number; to: number };
}

export interface JoinResult {
  /** One latency in milliseconds per (edit, receiver) pair that was observed. */
  latencies: Float64Array;
  /** Edits sent inside the window. */
  edits: number;
  expected: number;
  observed: number;
  missing: number;
  /** Receives of an edit by a receiver that had already received it. */
  duplicates: number;
  /** Receives that match no logged send. */
  unmatched: number;
  /** Receives stamped earlier than their send: the clocks disagree. */
  negative: number;
}

export function joinLatencies(input: JoinInput): JoinResult {
  const { sends, receives, receivers, window } = input;
  if (sends.length % 3 !== 0) throw new Error("sends must be rows of 3 numbers");
  if (receives.length % 4 !== 0) throw new Error("receives must be rows of 4 numbers");

  // writer -> clock -> index of the edit among the edits inside the window (or -1: warm-up)
  const byWriter = new Map<number, Map<number, number>>();
  const sentAt: number[] = [];
  for (let i = 0; i < sends.length; i += 3) {
    const writer = sends[i]!;
    const clock = sends[i + 1]!;
    const at = sends[i + 2]!;
    const inside = at >= window.from && at < window.to;
    let clocks = byWriter.get(writer);
    if (!clocks) byWriter.set(writer, (clocks = new Map()));
    if (inside) {
      clocks.set(clock, sentAt.length);
      sentAt.push(at);
    } else {
      clocks.set(clock, -1);
    }
  }

  const edits = sentAt.length;
  const seen = new Uint8Array(edits * receivers);
  const latencies: number[] = [];
  let duplicates = 0;
  let unmatched = 0;
  let negative = 0;
  for (let i = 0; i < receives.length; i += 4) {
    const receiver = receives[i]!;
    const index = byWriter.get(receives[i + 1]!)?.get(receives[i + 2]!);
    if (index === undefined) {
      unmatched += 1;
      continue;
    }
    if (index < 0) continue; // a warm-up edit
    const slot = index * receivers + receiver;
    if (seen[slot]) {
      duplicates += 1;
      continue;
    }
    seen[slot] = 1;
    const latency = receives[i + 3]! - sentAt[index]!;
    if (latency < 0) negative += 1;
    latencies.push(latency);
  }
  const expected = edits * (receivers - 1);
  return {
    latencies: Float64Array.from(latencies),
    edits,
    expected,
    observed: latencies.length,
    missing: expected - latencies.length,
    duplicates,
    unmatched,
    negative,
  };
}
