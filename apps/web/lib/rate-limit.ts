import { createHash } from "node:crypto";
import { addressKey } from "@collabdocs/shared";
import type { Redis } from "ioredis";
import { HttpError } from "./api";
import { getRedis } from "./redis";

/** The result of counting one attempt. */
export interface Hit {
  allowed: boolean;
  /** Seconds until the window ends and the count starts again. */
  retryAfterSeconds: number;
}

/**
 * Counts the attempt in a fixed window and increments in one step, so that
 * concurrent requests, on any instance, cannot all pass the last place. The TTL
 * is set in the same script: a crash cannot leave a counter that never expires.
 */
const COUNT = `
local n = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if n == 1 or ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {n, ttl}
`;

const REDIS_TIMEOUT_MS = 1000;

/**
 * A fixed-window counter shared through Redis. Without Redis, or while it is
 * unreachable, it counts in this process instead: the limit then holds per
 * instance, which is weaker than per cluster but never means no limit.
 */
export class RateLimiter {
  private readonly memory = new Map<string, { count: number; resetsAt: number }>();

  constructor(
    private readonly redis: () => Pick<Redis, "eval"> | null,
    private readonly prefix: string,
    private readonly now: () => number = Date.now,
    private readonly onFallback: (error: unknown) => void = () => {},
  ) {}

  async hit(key: string, limit: number, windowSeconds: number): Promise<Hit> {
    const redis = this.redis();
    if (redis) {
      try {
        const reply = (await withTimeout(
          redis.eval(COUNT, 1, `${this.prefix}${key}`, String(windowSeconds * 1000)),
          REDIS_TIMEOUT_MS,
        )) as [number, number];
        return {
          allowed: reply[0] <= limit,
          retryAfterSeconds: Math.max(1, Math.ceil(reply[1] / 1000)),
        };
      } catch (error) {
        this.onFallback(error);
      }
    }
    return this.hitMemory(key, limit, windowSeconds);
  }

  private hitMemory(key: string, limit: number, windowSeconds: number): Hit {
    const now = this.now();
    let entry = this.memory.get(key);
    if (!entry || entry.resetsAt <= now) {
      // Forget expired entries now and then, so that the map does not grow without bound.
      if (this.memory.size > 10_000) {
        for (const [k, v] of this.memory) if (v.resetsAt <= now) this.memory.delete(k);
      }
      entry = { count: 0, resetsAt: now + windowSeconds * 1000 };
      this.memory.set(key, entry);
    }
    entry.count += 1;
    return {
      allowed: entry.count <= limit,
      retryAfterSeconds: Math.max(1, Math.ceil((entry.resetsAt - now) / 1000)),
    };
  }
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("Redis did not answer in time")), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

let warnedFallback = false;
const shared = new RateLimiter(
  getRedis,
  process.env.RATE_LIMIT_PREFIX ?? "collabdocs:rl:",
  Date.now,
  (error) => {
    if (warnedFallback) return;
    warnedFallback = true;
    console.warn("rate limiting is falling back to this process: Redis failed", error);
  },
);

// ---- what is limited --------------------------------------------------------------

const FIFTEEN_MINUTES = 15 * 60;
const ONE_HOUR = 60 * 60;

function limitFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/** The limits, read when used. Each counts attempts, successful or not, per window. */
export function authLimits() {
  return {
    signIn: {
      perIp: {
        limit: limitFromEnv("AUTH_LIMIT_SIGNIN_PER_IP", 30),
        windowSeconds: FIFTEEN_MINUTES,
      },
      perAccount: {
        limit: limitFromEnv("AUTH_LIMIT_SIGNIN_PER_ACCOUNT", 10),
        windowSeconds: FIFTEEN_MINUTES,
      },
    },
    register: {
      perIp: { limit: limitFromEnv("AUTH_LIMIT_REGISTER_PER_IP", 10), windowSeconds: ONE_HOUR },
      perAccount: {
        limit: limitFromEnv("AUTH_LIMIT_REGISTER_PER_ACCOUNT", 3),
        windowSeconds: ONE_HOUR,
      },
    },
    verifyResend: {
      perAccount: {
        limit: limitFromEnv("AUTH_LIMIT_VERIFY_RESEND_PER_ACCOUNT", 3),
        windowSeconds: ONE_HOUR,
      },
    },
  };
}

let warnedHops = false;

/** TRUSTED_PROXY_HOPS: unset or empty means 1; anything but a whole number of 0 or more is refused loudly and means 1. */
function trustedHops(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return 1;
  const value = Number(raw);
  if (Number.isInteger(value) && value >= 0) return value;
  if (!warnedHops) {
    warnedHops = true;
    console.error(`TRUSTED_PROXY_HOPS must be a whole number, 0 or more, got "${raw}"; using 1`);
  }
  return 1;
}

/**
 * The client's address as the proxy in front of the app saw it. `X-Forwarded-For`
 * is a list that each proxy appends to; the entries a client wrote itself come
 * first, so only the one added by the outermost trusted proxy can be believed:
 * TRUSTED_PROXY_HOPS (default 1) counts from the end. With 0 the header is
 * ignored, and every request shares the bucket "unknown": the per-account limit
 * is then the one that protects. An IPv6 address counts as its /64.
 */
export function clientIp(
  headers: Headers,
  env: Record<string, string | undefined> = process.env,
): string {
  const hops = trustedHops(env.TRUSTED_PROXY_HOPS);
  if (hops <= 0) return "unknown";
  const forwarded = (headers.get("x-forwarded-for") ?? "")
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
  const address = forwarded[forwarded.length - hops];
  return address ? addressKey(address) : "unknown";
}

/** Accounts are keyed by a hash of the address, so that no email is stored in Redis keys. */
function accountKey(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 32);
}

export function rateLimited(retryAfterSeconds: number): HttpError {
  return new HttpError(
    429,
    "rate_limited",
    `Too many attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minute(s).`,
    { "Retry-After": String(retryAfterSeconds) },
  );
}

async function enforce(
  scope: string,
  ip: string | null,
  email: string | null,
  rules: {
    perIp?: { limit: number; windowSeconds: number };
    perAccount?: { limit: number; windowSeconds: number };
  },
  limiter: RateLimiter = shared,
): Promise<void> {
  // Both counters always count, so that a refused attempt still uses up the window.
  const hits: Hit[] = [];
  if (ip !== null && rules.perIp) {
    hits.push(await limiter.hit(`${scope}:ip:${ip}`, rules.perIp.limit, rules.perIp.windowSeconds));
  }
  if (email !== null && rules.perAccount) {
    hits.push(
      await limiter.hit(
        `${scope}:account:${accountKey(email)}`,
        rules.perAccount.limit,
        rules.perAccount.windowSeconds,
      ),
    );
  }
  const refused = hits.filter((hit) => !hit.allowed);
  if (refused.length > 0) throw rateLimited(Math.max(...refused.map((h) => h.retryAfterSeconds)));
}

/** Throws a 429 when this address or this account has signed in too often. `email` may be unknown. */
export function enforceSignInLimit(ip: string, email: string | null, limiter?: RateLimiter) {
  return enforce("signin", ip, email, authLimits().signIn, limiter);
}

export function enforceRegisterLimit(ip: string, email: string | null, limiter?: RateLimiter) {
  return enforce("register", ip, email, authLimits().register, limiter);
}

export function enforceVerifyResendLimit(email: string, limiter?: RateLimiter) {
  return enforce("resend", null, email, authLimits().verifyResend, limiter);
}

/** Confirming an address: limited per address of the client only; the token itself is the secret. */
export function enforceVerifyLimit(ip: string, limiter?: RateLimiter) {
  return enforce("verify", ip, null, { perIp: authLimits().signIn.perIp }, limiter);
}
