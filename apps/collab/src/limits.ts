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

/** How many of the least recently used buckets are looked at for one that is full again. */
const EVICTION_SCAN = 8;

/**
 * One token bucket per key (a user, a client address), created on first use. Memory is
 * bounded by `maxKeys`, high enough that honest traffic never reaches it. Past it the
 * least recently used bucket is forgotten, and a bucket forgotten comes back full, so
 * forgetting is a (small) gift to whoever it belonged to. Three things keep that from
 * being a cheap way to reset a limit: only the least recently used key goes (a client
 * that keeps sending is never the one), a key that is full again anyway is preferred,
 * and every eviction of a bucket that was not full is counted in `evictions`, which the
 * server reports as a metric: a rising count means a flood of distinct keys, or a
 * `maxKeys` that is too low for the traffic. The buckets live in this process: with n
 * instances a key has n buckets.
 */
export class KeyedRateLimiter {
  /** Insertion order is recency order: a used key is moved to the end. */
  private readonly buckets = new Map<string, RateLimiter>();
  private evicted = 0;

  constructor(
    private readonly perSecond: number,
    private readonly burst: number,
    private readonly now: () => number = Date.now,
    private readonly maxKeys = 100_000,
  ) {}

  allow(key: string, cost = 1): boolean {
    let bucket = this.buckets.get(key);
    if (bucket) {
      this.buckets.delete(key);
    } else {
      while (this.buckets.size >= this.maxKeys) this.evictOne();
      bucket = new RateLimiter(this.perSecond, this.burst, this.now);
    }
    this.buckets.set(key, bucket);
    return bucket.allow(cost);
  }

  get size(): number {
    return this.buckets.size;
  }

  /** Buckets dropped while they still held a deficit, since the start. */
  get evictions(): number {
    return this.evicted;
  }

  /** Drops a bucket from the cold end: a full one among the first few if there is one, else the oldest. */
  private evictOne(): void {
    let scanned = 0;
    for (const [key, bucket] of this.buckets) {
      if (bucket.isFull()) {
        this.buckets.delete(key);
        return;
      }
      scanned += 1;
      if (scanned >= EVICTION_SCAN) break;
    }
    const oldest = this.buckets.keys().next();
    if (oldest.done) return;
    this.buckets.delete(oldest.value);
    this.evicted += 1;
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
