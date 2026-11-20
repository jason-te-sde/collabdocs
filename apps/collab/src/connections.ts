import type { Redis } from "ioredis";
import { errorFields, type Logger } from "./logger";

/**
 * Counts the sockets of a document so that the per-document limit holds even when
 * many handshakes arrive at once, on one instance or on several. `join` checks the
 * limit and records the socket in one step.
 */
export interface ConnectionCounter {
  /** True when the socket was admitted; false when the document is at its limit. */
  join(documentId: string, socketId: string): Promise<boolean>;
  leave(documentId: string, socketId: string): Promise<void>;
  close(): void;
}

/** One instance on its own: check and add happen in one synchronous step. */
export class MemoryConnectionCounter implements ConnectionCounter {
  private readonly sockets = new Map<string, Set<string>>();

  constructor(private readonly limit: number) {}

  join(documentId: string, socketId: string): Promise<boolean> {
    let ids = this.sockets.get(documentId);
    if (!ids) this.sockets.set(documentId, (ids = new Set()));
    if (!ids.has(socketId) && ids.size >= this.limit) return Promise.resolve(false);
    ids.add(socketId);
    return Promise.resolve(true);
  }

  leave(documentId: string, socketId: string): Promise<void> {
    const ids = this.sockets.get(documentId);
    ids?.delete(socketId);
    if (ids?.size === 0) this.sockets.delete(documentId);
    return Promise.resolve();
  }

  close(): void {}
}

/**
 * Drops entries that expired, then admits the socket if there is room. One script,
 * so two instances cannot both take the last place. Time is Redis's own, so the
 * instances' clocks do not matter.
 */
const JOIN = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
local present = redis.call('ZSCORE', KEYS[1], ARGV[3])
if not present and redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then
  return 0
end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[1]), ARGV[3])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]) * 2)
return 1
`;

/** Pushes the expiry of sockets that are still connected. */
const REFRESH = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
for i = 2, #ARGV do
  redis.call('ZADD', KEYS[1], 'XX', now + tonumber(ARGV[1]), ARGV[i])
end
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]) * 2)
return 1
`;

/**
 * The cluster-wide count: a sorted set per document whose members are socket ids
 * and whose scores are expiry times. Each instance refreshes its own sockets, so
 * an instance that dies takes its sockets out of the count after `ttlMs`.
 */
export class RedisConnectionCounter implements ConnectionCounter {
  private readonly mine = new Map<string, Set<string>>();
  private readonly heartbeat: NodeJS.Timeout;

  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix: string,
    private readonly limit: number,
    private readonly ttlMs: number,
    private readonly logger: Logger,
  ) {
    this.heartbeat = setInterval(() => void this.refresh(), Math.max(1, Math.floor(ttlMs / 3)));
    this.heartbeat.unref();
  }

  private key(documentId: string): string {
    return `${this.keyPrefix}:conn:${documentId}`;
  }

  async join(documentId: string, socketId: string): Promise<boolean> {
    const admitted = await this.redis.eval(
      JOIN,
      1,
      this.key(documentId),
      String(this.ttlMs),
      String(this.limit),
      socketId,
    );
    if (admitted !== 1) return false;
    let ids = this.mine.get(documentId);
    if (!ids) this.mine.set(documentId, (ids = new Set()));
    ids.add(socketId);
    return true;
  }

  async leave(documentId: string, socketId: string): Promise<void> {
    const ids = this.mine.get(documentId);
    ids?.delete(socketId);
    if (ids?.size === 0) this.mine.delete(documentId);
    try {
      await this.redis.zrem(this.key(documentId), socketId);
    } catch (error) {
      // The entry expires on its own.
      this.logger.warn("could not release a connection slot", {
        documentId,
        ...errorFields(error),
      });
    }
  }

  private async refresh(): Promise<void> {
    for (const [documentId, ids] of this.mine) {
      try {
        await this.redis.eval(REFRESH, 1, this.key(documentId), String(this.ttlMs), ...ids);
      } catch (error) {
        this.logger.warn("could not refresh connection slots", {
          documentId,
          ...errorFields(error),
        });
      }
    }
  }

  close(): void {
    clearInterval(this.heartbeat);
  }
}
