import { MIN_SECRET_BYTES } from "@collabdocs/shared";
import { MIN_REDIS_SECRET_BYTES } from "@collabdocs/shared/redis-auth";
import { consoleLogger, type Logger } from "./logger";

export interface Limits {
  /** The largest accepted sync update or awareness update, in bytes. */
  maxUpdateBytes: number;
  /** Sustained messages per second one socket may send. */
  maxMessagesPerSecond: number;
  /** Messages a socket may send in one burst before the sustained rate applies. */
  messageBurst: number;
  /** Sockets that may be connected to one document, across all instances. */
  maxConnectionsPerDocument: number;
  /** Sustained payload bytes per second one socket may send. */
  maxBytesPerSecond: number;
  /** Payload bytes a socket may send in one burst; at least `maxUpdateBytes`. */
  byteBurst: number;
  /** Sockets one user may hold on one document, across all instances. */
  maxConnectionsPerUser: number;
  /** Handshakes one user may start in a burst, per instance; then `handshakesPerSecondPerUser` applies. */
  handshakeBurstPerUser: number;
  handshakesPerSecondPerUser: number;
  /**
   * An anti-flood ceiling per client address, per instance, counted only for handshakes
   * with a valid token. It is far above what a person or a user's devices need: an
   * address is shared by everyone behind a proxy or a NAT, so a tight value would let
   * one client lock out the rest. The limit that matters is the one per user.
   */
  handshakeBurstPerIp: number;
  handshakesPerSecondPerIp: number;
  /** Payload bytes per second all sockets of one user share, per instance. */
  maxBytesPerSecondPerUser: number;
  /** Payload bytes all sockets of one user may send in one burst; at least `maxUpdateBytes`. */
  byteBurstPerUser: number;
  /** Payload bytes received but not yet processed, over every socket of the instance. */
  maxInFlightBytes: number;
  /** Unresolved Yjs structure per document (updates whose dependencies never arrived), in bytes. */
  maxPendingStructBytes: number;
  /** The most a document may occupy in the database (snapshot plus log), in bytes. */
  maxDocumentBytes: number;
  /** Updates accepted but not yet committed to the log, per document, in bytes. */
  maxPendingBytes: number;
  /** The largest accepted awareness update, in bytes. */
  maxAwarenessBytes: number;
  /**
   * The most bytes the server may hold queued for one connection, that the client has not
   * taken, when the client is not draining the queue. A periodic sweep over every
   * connection closes one that has been over it for `STALL_WINDOW_MS` (3 s) without its queue shrinking, so
   * a client reading a large reply at any real rate is not closed however long it takes,
   * and one that has stopped reading is closed after about 3 seconds. A sync reply is not
   * queued for a connection already over it, and a broadcast closes a connection at once
   * when it is over it by more than `maxDocumentBytes`, the most one reply can add.
   */
  maxOutboundBytes: number;
  /**
   * The most packets the server may hold queued for one connection, that the transport has
   * not taken. It bounds floods of tiny packets, which the byte cap lets through. Checked
   * at the same places as `maxOutboundBytes`. A message with a binary payload is two packets.
   */
  maxOutboundPackets: number;
  /**
   * Sustained Engine.IO packets per second one connection may send, before and after it
   * joins a document. It counts everything the transport carries (a message with a binary
   * payload is two packets, a heartbeat is one), so it is above twice
   * `maxMessagesPerSecond`. A connection over it is closed.
   */
  maxPacketsPerSecond: number;
  /** Packets a connection may send in one burst; above twice `messageBurst`. */
  packetBurst: number;
}

export interface PersistenceOptions {
  /** Compact the log into a snapshot after this many appended updates. */
  compactEveryUpdates: number;
  /** Compact at the latest this long after the first uncompacted update. */
  compactAfterMs: number;
  /** Keep a document in memory this long after its last client left. */
  unloadGraceMs: number;
  /** How often a loaded document reads the log for updates its instance did not see. */
  reconcileIntervalMs: number;
  /** How often connected members are checked against the database. */
  membershipRecheckMs: number;
  /** A socket's role is read again before a write if it was last read longer ago than this. */
  roleCacheMs: number;
}

export interface CollabServerOptions {
  /** 0 picks a free port. */
  port: number;
  host?: string;
  databaseUrl: string;
  tokenSecret: string;
  /** Without it the server runs alone: no relay, no membership channel, counters in memory. */
  redisUrl?: string;
  /**
   * Signs the messages on the Redis channels. Required with `redisUrl`; at least 32
   * bytes, and different from `tokenSecret`. The web app needs the same value.
   */
  redisMessageSecret?: string;
  /** Prefix of this server's Redis channel and keys. */
  adapterKey: string;
  /** With Redis configured, the server refuses to start if it cannot connect within this time. */
  redisConnectTimeoutMs: number;
  /** A connection slot not refreshed for this long is treated as gone (an instance that died). */
  connectionTtlMs: number;
  membershipChannel: string;
  /**
   * How many proxies in front of the server append to X-Forwarded-For. The client
   * address of a handshake is the entry that many places from the end; 0 (the
   * default) uses the socket's own address and ignores the header.
   */
  trustedProxyHops: number;
  /** Whether the hop count was set by the operator (also true for an explicit 0). */
  trustedProxyHopsConfigured: boolean;
  /** Most distinct keys one rate limiter keeps buckets for; past it the least recently used go. */
  rateLimiterMaxKeys: number;
  /**
   * Browser origins allowed to open a socket, on the WebSocket upgrade and on polling
   * requests. Unset, only the server's own origin is allowed. A request that carries
   * no Origin header (not a browser) is not affected: the token is its credential.
   */
  corsOrigin?: string | string[];
  limits: Limits;
  persistence: PersistenceOptions;
  logger: Logger;
  /** Names this instance in logs and in relayed messages. */
  instanceId?: string;
}

export const DEFAULT_LIMITS: Limits = {
  maxUpdateBytes: 1024 * 1024,
  maxMessagesPerSecond: 100,
  messageBurst: 200,
  maxConnectionsPerDocument: 250,
  maxConnectionsPerUser: 8,
  handshakeBurstPerUser: 20,
  handshakesPerSecondPerUser: 1,
  handshakeBurstPerIp: 2000,
  handshakesPerSecondPerIp: 100,
  maxBytesPerSecondPerUser: 512 * 1024,
  byteBurstPerUser: 4 * 1024 * 1024,
  maxInFlightBytes: 64 * 1024 * 1024,
  maxPendingStructBytes: 1024 * 1024,
  maxBytesPerSecond: 256 * 1024,
  byteBurst: 2 * 1024 * 1024,
  maxDocumentBytes: 16 * 1024 * 1024,
  maxPendingBytes: 8 * 1024 * 1024,
  maxAwarenessBytes: 8 * 1024,
  // Four times the default `maxUpdateBytes`: room for a few of the largest updates to be
  // in flight to a slow client, and no more.
  maxOutboundBytes: 4 * 1024 * 1024,
  // At the busiest load measured, a socket is sent about 1200 packets per second, so this is
  // more than ten seconds of that for a transport that has stopped taking packets.
  maxOutboundPackets: 16_384,
  maxPacketsPerSecond: 250,
  packetBurst: 500,
};

export const DEFAULT_PERSISTENCE: PersistenceOptions = {
  compactEveryUpdates: 200,
  compactAfterMs: 30_000,
  unloadGraceMs: 30_000,
  reconcileIntervalMs: 5_000,
  membershipRecheckMs: 60_000,
  roleCacheMs: 1_000,
};

type OptionOverrides = Partial<
  Omit<CollabServerOptions, "limits" | "persistence" | "trustedProxyHopsConfigured">
> & {
  databaseUrl: string;
  tokenSecret: string;
  limits?: Partial<Limits>;
  persistence?: Partial<PersistenceOptions>;
};

/** Fills in defaults and refuses values that cannot work. */
export function resolveOptions(input: OptionOverrides): CollabServerOptions {
  const options: CollabServerOptions = {
    port: 0,
    adapterKey: "collabdocs-io",
    redisConnectTimeoutMs: 5_000,
    connectionTtlMs: 45_000,
    membershipChannel: "collabdocs:membership",
    trustedProxyHops: 0,
    rateLimiterMaxKeys: 100_000,
    logger: consoleLogger,
    ...input,
    trustedProxyHopsConfigured: input.trustedProxyHops !== undefined,
    limits: { ...DEFAULT_LIMITS, ...input.limits },
    persistence: { ...DEFAULT_PERSISTENCE, ...input.persistence },
  };
  if (new TextEncoder().encode(options.tokenSecret).length < MIN_SECRET_BYTES) {
    throw new Error(`COLLAB_TOKEN_SECRET must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  if (options.redisUrl) {
    const secret = options.redisMessageSecret;
    if (!secret) throw new Error("REDIS_MESSAGE_SECRET is required when REDIS_URL is set");
    if (new TextEncoder().encode(secret).length < MIN_REDIS_SECRET_BYTES) {
      throw new Error(`REDIS_MESSAGE_SECRET must be at least ${MIN_REDIS_SECRET_BYTES} bytes`);
    }
    if (secret === options.tokenSecret) {
      throw new Error("REDIS_MESSAGE_SECRET must differ from COLLAB_TOKEN_SECRET");
    }
  }
  for (const [name, value] of [
    ["redisConnectTimeoutMs", options.redisConnectTimeoutMs] as const,
    ["connectionTtlMs", options.connectionTtlMs] as const,
    ["rateLimiterMaxKeys", options.rateLimiterMaxKeys] as const,
    ...Object.entries(options.limits),
    ...Object.entries(options.persistence),
  ]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
  }
  if (options.limits.byteBurst < options.limits.maxUpdateBytes) {
    throw new Error("byteBurst must be at least maxUpdateBytes, or the largest update never fits");
  }
  if (options.limits.byteBurstPerUser < options.limits.maxUpdateBytes) {
    throw new Error(
      "byteBurstPerUser must be at least maxUpdateBytes, or the largest update never fits",
    );
  }
  if (!Number.isInteger(options.trustedProxyHops) || options.trustedProxyHops < 0) {
    throw new Error("trustedProxyHops must be a whole number, 0 or more");
  }
  return options;
}

function number(env: NodeJS.ProcessEnv, name: string): number | undefined {
  const raw = env[name];
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`);
  return value;
}

function defined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

/** Reads the configuration from environment variables. See the README for the list. */
export function optionsFromEnv(env: NodeJS.ProcessEnv): CollabServerOptions {
  const databaseUrl = env.DATABASE_URL;
  const tokenSecret = env.COLLAB_TOKEN_SECRET;
  if (!databaseUrl) throw new Error("DATABASE_URL is not set");
  if (!tokenSecret) throw new Error("COLLAB_TOKEN_SECRET is not set");
  const origins = env.COLLAB_CORS_ORIGIN?.split(",").map((o) => o.trim());
  return resolveOptions({
    databaseUrl,
    tokenSecret,
    port: number(env, "COLLAB_PORT") ?? 4000,
    ...(env.COLLAB_HOST ? { host: env.COLLAB_HOST } : {}),
    ...(env.REDIS_URL ? { redisUrl: env.REDIS_URL } : {}),
    ...(env.REDIS_MESSAGE_SECRET ? { redisMessageSecret: env.REDIS_MESSAGE_SECRET } : {}),
    ...(origins ? { corsOrigin: origins } : {}),
    ...(env.COLLAB_INSTANCE_ID ? { instanceId: env.COLLAB_INSTANCE_ID } : {}),
    ...defined({
      redisConnectTimeoutMs: number(env, "COLLAB_REDIS_CONNECT_TIMEOUT_MS"),
      connectionTtlMs: number(env, "COLLAB_CONNECTION_TTL_MS"),
      trustedProxyHops: number(env, "COLLAB_TRUSTED_PROXY_HOPS"),
      rateLimiterMaxKeys: number(env, "COLLAB_RATE_LIMITER_MAX_KEYS"),
    }),
    limits: defined({
      maxUpdateBytes: number(env, "COLLAB_MAX_UPDATE_BYTES"),
      maxMessagesPerSecond: number(env, "COLLAB_MAX_MESSAGES_PER_SECOND"),
      messageBurst: number(env, "COLLAB_MESSAGE_BURST"),
      maxConnectionsPerDocument: number(env, "COLLAB_MAX_CONNECTIONS_PER_DOCUMENT"),
      maxConnectionsPerUser: number(env, "COLLAB_MAX_CONNECTIONS_PER_USER"),
      handshakeBurstPerUser: number(env, "COLLAB_HANDSHAKE_BURST_PER_USER"),
      handshakesPerSecondPerUser: number(env, "COLLAB_HANDSHAKES_PER_SECOND_PER_USER"),
      handshakeBurstPerIp: number(env, "COLLAB_HANDSHAKE_BURST_PER_IP"),
      handshakesPerSecondPerIp: number(env, "COLLAB_HANDSHAKES_PER_SECOND_PER_IP"),
      maxBytesPerSecondPerUser: number(env, "COLLAB_MAX_BYTES_PER_SECOND_PER_USER"),
      byteBurstPerUser: number(env, "COLLAB_BYTE_BURST_PER_USER"),
      maxInFlightBytes: number(env, "COLLAB_MAX_IN_FLIGHT_BYTES"),
      maxPendingStructBytes: number(env, "COLLAB_MAX_PENDING_STRUCT_BYTES"),
      maxBytesPerSecond: number(env, "COLLAB_MAX_BYTES_PER_SECOND"),
      byteBurst: number(env, "COLLAB_BYTE_BURST"),
      maxDocumentBytes: number(env, "COLLAB_MAX_DOCUMENT_BYTES"),
      maxPendingBytes: number(env, "COLLAB_MAX_PENDING_BYTES"),
      maxAwarenessBytes: number(env, "COLLAB_MAX_AWARENESS_BYTES"),
      maxOutboundBytes: number(env, "COLLAB_MAX_OUTBOUND_BYTES"),
      maxOutboundPackets: number(env, "COLLAB_MAX_OUTBOUND_PACKETS"),
      maxPacketsPerSecond: number(env, "COLLAB_MAX_PACKETS_PER_SECOND"),
      packetBurst: number(env, "COLLAB_PACKET_BURST"),
    }),
    persistence: defined({
      compactEveryUpdates: number(env, "COLLAB_COMPACT_EVERY_UPDATES"),
      compactAfterMs: number(env, "COLLAB_COMPACT_AFTER_MS"),
      unloadGraceMs: number(env, "COLLAB_UNLOAD_GRACE_MS"),
      reconcileIntervalMs: number(env, "COLLAB_RECONCILE_INTERVAL_MS"),
      membershipRecheckMs: number(env, "COLLAB_MEMBERSHIP_RECHECK_MS"),
      roleCacheMs: number(env, "COLLAB_ROLE_CACHE_MS"),
    }),
  });
}
