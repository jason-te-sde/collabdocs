/** A token bucket: `burst` units at once, refilled at `perSecond`. A unit is a message or a byte. */
export class RateLimiter {
  private tokens: number;
  private last: number;

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
  ) {
    this.tokens = burst;
    this.last = now();
  }

  /** Takes `cost` units from the bucket; false when the socket is over its rate. */
  allow(cost = 1): boolean {
    const t = this.now();
    this.tokens = Math.min(this.burst, this.tokens + ((t - this.last) / 1000) * this.perSecond);
    this.last = t;
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }
}

/** The size a message payload counts for against a socket's byte budget. */
export function payloadBytes(payload: unknown): number {
  if (payload instanceof Uint8Array || payload instanceof ArrayBuffer) return payload.byteLength;
  if (typeof payload === "string") return Buffer.byteLength(payload);
  return 0;
}
