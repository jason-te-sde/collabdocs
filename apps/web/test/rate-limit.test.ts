import { randomUUID } from "node:crypto";
import { Redis } from "ioredis";
import { afterAll, describe, expect, it } from "vitest";
import { clientIp, RateLimiter } from "@/lib/rate-limit";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error("REDIS_URL is not set; this test needs a Redis server");
const redis = new Redis(redisUrl);
const prefix = `collabdocs:rl-unit-${randomUUID().slice(0, 8)}:`;

afterAll(async () => {
  const keys = await redis.keys(`${prefix}*`);
  if (keys.length > 0) await redis.del(...keys);
  redis.disconnect();
});

describe("RateLimiter without Redis (one process)", () => {
  it("allows the limit, then refuses until the window is over", async () => {
    let now = 1_000_000;
    const limiter = new RateLimiter(
      () => null,
      "",
      () => now,
    );
    const hits = [];
    for (let i = 0; i < 4; i += 1) hits.push(await limiter.hit("k", 3, 60));
    expect(hits.map((h) => h.allowed)).toEqual([true, true, true, false]);
    expect(hits[3]!.retryAfterSeconds).toBe(60);
    now += 20_000;
    expect((await limiter.hit("k", 3, 60)).retryAfterSeconds).toBe(40);
    now += 40_000;
    expect((await limiter.hit("k", 3, 60)).allowed).toBe(true);
  });

  it("counts keys separately", async () => {
    const limiter = new RateLimiter(() => null, "");
    expect((await limiter.hit("a", 1, 60)).allowed).toBe(true);
    expect((await limiter.hit("a", 1, 60)).allowed).toBe(false);
    expect((await limiter.hit("b", 1, 60)).allowed).toBe(true);
  });
});

describe("RateLimiter through Redis", () => {
  it("shares the count between instances and sets an expiry", async () => {
    const key = `shared-${randomUUID()}`;
    const a = new RateLimiter(() => redis, prefix);
    const b = new RateLimiter(() => redis, prefix);
    expect((await a.hit(key, 3, 60)).allowed).toBe(true);
    expect((await b.hit(key, 3, 60)).allowed).toBe(true);
    expect((await a.hit(key, 3, 60)).allowed).toBe(true);
    const fourth = await b.hit(key, 3, 60);
    expect(fourth.allowed).toBe(false);
    expect(fourth.retryAfterSeconds).toBeGreaterThan(0);
    expect(fourth.retryAfterSeconds).toBeLessThanOrEqual(60);
    const ttl = await redis.pttl(`${prefix}${key}`);
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(60_000);
  });

  it("lets exactly the limit through when attempts arrive at once", async () => {
    const key = `burst-${randomUUID()}`;
    const limiters = [new RateLimiter(() => redis, prefix), new RateLimiter(() => redis, prefix)];
    const results = await Promise.all(
      Array.from({ length: 40 }, (_, i) => limiters[i % 2]!.hit(key, 10, 60)),
    );
    expect(results.filter((r) => r.allowed)).toHaveLength(10);
  });

  it("expires: the count starts again after the window", async () => {
    const key = `expiry-${randomUUID()}`;
    const limiter = new RateLimiter(() => redis, prefix);
    expect((await limiter.hit(key, 1, 1)).allowed).toBe(true);
    expect((await limiter.hit(key, 1, 1)).allowed).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    expect((await limiter.hit(key, 1, 1)).allowed).toBe(true);
  });

  it("falls back to counting in the process when Redis fails, and says so", async () => {
    const broken = { eval: () => Promise.reject(new Error("connection refused")) };
    const failures: unknown[] = [];
    const limiter = new RateLimiter(
      () => broken as unknown as Redis,
      prefix,
      Date.now,
      (error) => failures.push(error),
    );
    expect((await limiter.hit("k", 2, 60)).allowed).toBe(true);
    expect((await limiter.hit("k", 2, 60)).allowed).toBe(true);
    // Never "no limit": the in-process count refuses the third.
    expect((await limiter.hit("k", 2, 60)).allowed).toBe(false);
    expect(failures).toHaveLength(3);
  });

  it("falls back when Redis does not answer in time", async () => {
    const silent = { eval: () => new Promise(() => {}) };
    const limiter = new RateLimiter(() => silent as unknown as Redis, prefix);
    const started = Date.now();
    expect((await limiter.hit("k", 1, 60)).allowed).toBe(true);
    expect((await limiter.hit("k", 1, 60)).allowed).toBe(false);
    expect(Date.now() - started).toBeLessThan(4000);
  });
});

describe("clientIp", () => {
  const headers = (forwarded?: string) =>
    new Headers(forwarded === undefined ? {} : { "x-forwarded-for": forwarded });

  it("believes the address that the outermost trusted proxy appended, not the client's own", () => {
    // The client claims to be 6.6.6.6; the proxy saw the connection come from 203.0.113.9.
    expect(clientIp(headers("6.6.6.6, 203.0.113.9"), {})).toBe("203.0.113.9");
    expect(clientIp(headers("203.0.113.9"), {})).toBe("203.0.113.9");
  });

  it("counts proxies from the end with TRUSTED_PROXY_HOPS", () => {
    const env = { TRUSTED_PROXY_HOPS: "2" };
    expect(clientIp(headers("6.6.6.6, 203.0.113.9, 10.0.0.1"), env)).toBe("203.0.113.9");
  });

  it("treats an empty or unset TRUSTED_PROXY_HOPS as the default of one, not as zero", () => {
    expect(clientIp(headers("6.6.6.6, 203.0.113.9"), { TRUSTED_PROXY_HOPS: "" })).toBe(
      "203.0.113.9",
    );
    expect(clientIp(headers("6.6.6.6, 203.0.113.9"), { TRUSTED_PROXY_HOPS: "  " })).toBe(
      "203.0.113.9",
    );
    // A value that is not a whole number does not switch the limit off either.
    expect(clientIp(headers("6.6.6.6, 203.0.113.9"), { TRUSTED_PROXY_HOPS: "lots" })).toBe(
      "203.0.113.9",
    );
    expect(clientIp(headers("6.6.6.6, 203.0.113.9"), { TRUSTED_PROXY_HOPS: "-1" })).toBe(
      "203.0.113.9",
    );
  });

  it("counts every address of one IPv6 /64 as one client", () => {
    const a = clientIp(headers("2001:db8:1:2::1"), {});
    const b = clientIp(headers("2001:db8:1:2:dead:beef:0:7"), {});
    expect(a).toBe("2001:db8:1:2");
    expect(b).toBe(a);
    expect(clientIp(headers("2001:db8:1:3::1"), {})).not.toBe(a);
  });

  it("ignores the header with no trusted proxy, and without a header", () => {
    expect(clientIp(headers("203.0.113.9"), { TRUSTED_PROXY_HOPS: "0" })).toBe("unknown");
    expect(clientIp(headers(), {})).toBe("unknown");
  });
});
