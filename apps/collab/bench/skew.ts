import type { ChildProcess } from "node:child_process";
import { nowMs } from "./client";

export interface Exchange {
  /** Our clock when we sent the question. */
  sent: number;
  /** The other process's clock when it answered. */
  remote: number;
  /** Our clock when the answer arrived. */
  received: number;
}

/**
 * The offset of another process's clock from ours (positive: theirs is ahead), from
 * ping-pong exchanges as NTP does it: the exchange with the shortest round trip is the
 * least disturbed, the answer is taken to have been made at its midpoint, and half the round
 * trip bounds the error.
 */
export function estimateOffset(exchanges: Exchange[]): { offsetMs: number; uncertaintyMs: number } {
  if (exchanges.length === 0) throw new Error("no exchange to estimate from");
  let best = exchanges[0]!;
  for (const e of exchanges) {
    if (e.received - e.sent < best.received - best.sent) best = e;
  }
  return {
    offsetMs: best.remote - (best.sent + best.received) / 2,
    uncertaintyMs: (best.received - best.sent) / 2,
  };
}

/** Pings a forked process that answers `ping` with `pong` carrying its own `nowMs()`. */
export async function measureSkew(
  child: ChildProcess,
  rounds = 200,
): Promise<{ offsetMs: number; uncertaintyMs: number }> {
  const exchanges: Exchange[] = [];
  for (let id = 0; id < rounds; id += 1) {
    const sent = nowMs();
    const remote = await new Promise<number>((resolve) => {
      const onMessage = (m: { type?: string; id?: number; t?: number }) => {
        if (m.type === "pong" && m.id === id) {
          child.off("message", onMessage);
          resolve(m.t!);
        }
      };
      child.on("message", onMessage);
      child.send({ type: "ping", id });
    });
    exchanges.push({ sent, remote, received: nowMs() });
  }
  return estimateOffset(exchanges);
}
