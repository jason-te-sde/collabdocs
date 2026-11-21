import type { Redis } from "ioredis";
import { errorFields, type Logger } from "./logger";

/** What `join` answers: admitted, or which limit stopped it. */
export type JoinResult = "ok" | "document_full" | "user_full";

/**
 * Counts the sockets of a document, and of each user on it, so that the limits hold
 * even when many handshakes arrive at once, on one instance or on several. `join`
 * checks both limits and records the socket in one step.
 */
export interface ConnectionCounter {
  /**
   * `alive` says whether the socket is still connected; a counter that refreshes slots
   * must not refresh the slot of a socket that is gone.
   */
  join(
    documentId: string,
    socketId: string,
    userId: string,
    alive?: () => boolean,
  ): Promise<JoinResult>;
  leave(documentId: string, socketId: string, userId: string): Promise<void>;
  close(): void;
}

/** One instance on its own: check and add happen in one synchronous step. */
export class MemoryConnectionCounter implements ConnectionCounter {
  private readonly sockets = new Map<string, Map<string, string>>();

  constructor(
    private readonly limit: number,
    private readonly perUser: number,
  ) {}

  join(documentId: string, socketId: string, userId: string): Promise<JoinResult> {
    let ids = this.sockets.get(documentId);
    if (!ids) this.sockets.set(documentId, (ids = new Map()));
    if (!ids.has(socketId)) {
      if (ids.size >= this.limit) return Promise.resolve("document_full");
      let mine = 0;
      for (const owner of ids.values()) if (owner === userId) mine += 1;
      if (mine >= this.perUser) return Promise.resolve("user_full");
    }
    ids.set(socketId, userId);
    return Promise.resolve("ok");
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
 * Drops entries that expired, then admits the socket if there is room in the document
 * and in the user's share of it. One script, so two instances cannot both take the last
 * place. Time is Redis's own, so the instances' clocks do not matter.
 * KEYS: the document's set, the user's set. ARGV: ttl, document limit, socket id, user limit.
 */
const JOIN = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
redis.call('ZREMRANGEBYSCORE', KEYS[1], '-inf', now)
redis.call('ZREMRANGEBYSCORE', KEYS[2], '-inf', now)
if not redis.call('ZSCORE', KEYS[1], ARGV[3]) then
  if redis.call('ZCARD', KEYS[1]) >= tonumber(ARGV[2]) then
    return 0
  end
  if redis.call('ZCARD', KEYS[2]) >= tonumber(ARGV[4]) then
    return 2
  end
end
redis.call('ZADD', KEYS[1], now + tonumber(ARGV[1]), ARGV[3])
redis.call('ZADD', KEYS[2], now + tonumber(ARGV[1]), ARGV[3])
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]) * 2)
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[1]) * 2)
return 1
`;

/**
 * Pushes the expiry of sockets that are still connected, and puts back one whose entry
 * was lost (expired during a failed refresh, or gone in a Redis restart).
 * KEYS: the document's set, the user's set. ARGV: ttl, then socket ids.
 */
const REFRESH = `
local t = redis.call('TIME')
local now = t[1] * 1000 + math.floor(t[2] / 1000)
for i = 2, #ARGV do
  redis.call('ZADD', KEYS[1], now + tonumber(ARGV[1]), ARGV[i])
  redis.call('ZADD', KEYS[2], now + tonumber(ARGV[1]), ARGV[i])
end
redis.call('PEXPIRE', KEYS[1], tonumber(ARGV[1]) * 2)
redis.call('PEXPIRE', KEYS[2], tonumber(ARGV[1]) * 2)
return 1
`;

/**
 * The cluster-wide count: a sorted set per document whose members are socket ids
 * and whose scores are expiry times. Each instance refreshes its own sockets, so
 * an instance that dies takes its sockets out of the count after `ttlMs`.
 */
export class RedisConnectionCounter implements ConnectionCounter {
  /** document id, then user id, then socket id to the socket's liveness check. */
  private readonly mine = new Map<string, Map<string, Map<string, () => boolean>>>();
  private readonly heartbeat: NodeJS.Timeout;
  private refreshing = false;

  constructor(
    private readonly redis: Redis,
    private readonly keyPrefix: string,
    private readonly limit: number,
    private readonly ttlMs: number,
    private readonly perUser: number,
    private readonly logger: Logger,
  ) {
    this.heartbeat = setInterval(() => void this.refresh(), Math.max(1, Math.floor(ttlMs / 3)));
    this.heartbeat.unref();
  }

  private key(documentId: string): string {
    return `${this.keyPrefix}:conn:${documentId}`;
  }

  private userKey(documentId: string, userId: string): string {
    return `${this.keyPrefix}:conn:${documentId}:user:${userId}`;
  }

  async join(
    documentId: string,
    socketId: string,
    userId: string,
    alive: () => boolean = () => true,
  ): Promise<JoinResult> {
    const reply = await this.redis.eval(
      JOIN,
      2,
      this.key(documentId),
      this.userKey(documentId, userId),
      String(this.ttlMs),
      String(this.limit),
      socketId,
      String(this.perUser),
    );
    if (reply === 0) return "document_full";
    if (reply === 2) return "user_full";
    let users = this.mine.get(documentId);
    if (!users) this.mine.set(documentId, (users = new Map()));
    let ids = users.get(userId);
    if (!ids) users.set(userId, (ids = new Map()));
    ids.set(socketId, alive);
    return "ok";
  }

  async leave(documentId: string, socketId: string, userId: string): Promise<void> {
    this.forget(documentId, userId, socketId);
    try {
      await this.redis.zrem(this.key(documentId), socketId);
      await this.redis.zrem(this.userKey(documentId, userId), socketId);
    } catch (error) {
      // The entry expires on its own.
      this.logger.warn("could not release a connection slot", {
        documentId,
        ...errorFields(error),
      });
    }
  }

  private forget(documentId: string, userId: string, socketId: string): void {
    const users = this.mine.get(documentId);
    const ids = users?.get(userId);
    ids?.delete(socketId);
    if (ids?.size === 0) users?.delete(userId);
    if (users?.size === 0) this.mine.delete(documentId);
  }

  /**
   * One round for every document and user, sent together. A slot whose socket is gone
   * is released instead of refreshed, whatever left it behind.
   */
  private async refresh(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const work: Array<Promise<unknown>> = [];
      for (const [documentId, users] of [...this.mine]) {
        for (const [userId, ids] of [...users]) {
          const live: string[] = [];
          for (const [socketId, alive] of [...ids]) {
            if (alive()) live.push(socketId);
            else work.push(this.leave(documentId, socketId, userId));
          }
          if (live.length === 0) continue;
          work.push(
            this.redis
              .eval(
                REFRESH,
                2,
                this.key(documentId),
                this.userKey(documentId, userId),
                String(this.ttlMs),
                ...live,
              )
              .catch((error: unknown) =>
                this.logger.warn("could not refresh connection slots", {
                  documentId,
                  ...errorFields(error),
                }),
              ),
          );
        }
      }
      await Promise.all(work);
    } finally {
      this.refreshing = false;
    }
  }

  close(): void {
    clearInterval(this.heartbeat);
  }
}
