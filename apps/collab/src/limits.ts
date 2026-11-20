import { addressKey } from "@collabdocs/shared";

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

  /** True when the bucket is back at its burst: forgetting it changes nothing. */
  isFull(): boolean {
    return this.tokens + ((this.now() - this.last) / 1000) * this.perSecond >= this.burst;
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

/**
 * One token bucket per key (a user, a client address), created on first use. The map
 * is bounded: past `maxKeys`, buckets that are full again are forgotten (which loses
 * nothing), and if that is not enough the oldest go, so a flood of distinct keys
 * cannot grow memory without bound.
 */
export class KeyedRateLimiter {
  private readonly buckets = new Map<string, RateLimiter>();

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 10_000,
  ) {}

  allow(key: string, cost = 1): boolean {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.prune();
      bucket = new RateLimiter(this.perSecond, this.burst, this.now);
      this.buckets.set(key, bucket);
    }
    return bucket.allow(cost);
  }

  get size(): number {
    return this.buckets.size;
  }

  private prune(): void {
    for (const [key, bucket] of this.buckets) if (bucket.isFull()) this.buckets.delete(key);
    for (const key of this.buckets.keys()) {
      if (this.buckets.size < this.maxKeys) break;
      this.buckets.delete(key);
    }
  }
}

/**
 * The client address of a connection. Behind `hops` trusted proxies it is the entry of
 * X-Forwarded-For that many places from the end (the ones before it were written by the
 * client); with none, or when the header is missing, it is the socket's own address.
 * An IPv6 address is reduced to its /64, which one subscriber controls entirely.
 */
export function clientAddress(
  socketAddress: string,
  forwardedFor: string | string[] | undefined,
  hops: number,
): string {
  let address = socketAddress;
  if (hops > 0 && forwardedFor !== undefined) {
    const header = Array.isArray(forwardedFor) ? forwardedFor.join(",") : forwardedFor;
    const entries = header
      .split(",")
      .map((entry) => entry.trim())
      .filter(Boolean);
    const found = entries[entries.length - hops];
    if (found) address = found;
  }
  return addressKey(address);
}
