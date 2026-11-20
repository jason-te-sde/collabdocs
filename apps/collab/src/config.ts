import { MIN_SECRET_BYTES } from "@collabdocs/shared";
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
}

export interface CollabServerOptions {
  /** 0 picks a free port. */
  port: number;
  host?: string;
  databaseUrl: string;
  tokenSecret: string;
  /** Without it the server runs alone: no adapter, no membership channel. */
  redisUrl?: string;
  /** Prefix of the Socket.IO adapter's Redis channels. */
  adapterKey: string;
  membershipChannel: string;
  /** Allowed browser origin for the socket handshake; unset allows none (same-origin only). */
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
};

export const DEFAULT_PERSISTENCE: PersistenceOptions = {
  compactEveryUpdates: 200,
  compactAfterMs: 30_000,
  unloadGraceMs: 30_000,
  reconcileIntervalMs: 5_000,
  membershipRecheckMs: 60_000,
};

type OptionOverrides = Partial<Omit<CollabServerOptions, "limits" | "persistence">> & {
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
    membershipChannel: "collabdocs:membership",
    logger: consoleLogger,
    ...input,
    limits: { ...DEFAULT_LIMITS, ...input.limits },
    persistence: { ...DEFAULT_PERSISTENCE, ...input.persistence },
  };
  if (new TextEncoder().encode(options.tokenSecret).length < MIN_SECRET_BYTES) {
    throw new Error(`COLLAB_TOKEN_SECRET must be at least ${MIN_SECRET_BYTES} bytes`);
  }
  for (const [name, value] of [
    ...Object.entries(options.limits),
    ...Object.entries(options.persistence),
  ]) {
    if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number`);
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
    ...(origins ? { corsOrigin: origins } : {}),
    ...(env.COLLAB_INSTANCE_ID ? { instanceId: env.COLLAB_INSTANCE_ID } : {}),
    limits: defined({
      maxUpdateBytes: number(env, "COLLAB_MAX_UPDATE_BYTES"),
      maxMessagesPerSecond: number(env, "COLLAB_MAX_MESSAGES_PER_SECOND"),
      messageBurst: number(env, "COLLAB_MESSAGE_BURST"),
      maxConnectionsPerDocument: number(env, "COLLAB_MAX_CONNECTIONS_PER_DOCUMENT"),
    }),
    persistence: defined({
      compactEveryUpdates: number(env, "COLLAB_COMPACT_EVERY_UPDATES"),
      compactAfterMs: number(env, "COLLAB_COMPACT_AFTER_MS"),
      unloadGraceMs: number(env, "COLLAB_UNLOAD_GRACE_MS"),
      reconcileIntervalMs: number(env, "COLLAB_RECONCILE_INTERVAL_MS"),
      membershipRecheckMs: number(env, "COLLAB_MEMBERSHIP_RECHECK_MS"),
    }),
  });
}
