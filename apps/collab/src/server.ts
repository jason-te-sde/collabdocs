import { createServer, type IncomingMessage, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo, Socket as NetSocket } from "node:net";
import {
  COLLAB_EVENTS,
  ROLES,
  verifyCollabToken,
  type HandshakeErrorCode,
  type Role,
} from "@collabdocs/shared";
import { openMembershipChange } from "@collabdocs/shared/redis-auth";
import { Redis, type RedisOptions } from "ioredis";
import { Server } from "socket.io";
import { resolveOptions, type CollabServerOptions } from "./config";
import { DocumentRegistry } from "./document";
import { errorFields } from "./logger";
import {
  MemoryConnectionCounter,
  RedisConnectionCounter,
  type ConnectionCounter,
} from "./connections";
import { KeyedRateLimiter, RateLimiter, clientAddress, payloadBytes } from "./limits";
import {
  dropConnection,
  engineConnections,
  guardConnection,
  queuedBytes,
  queuedPackets,
  stalledOverCap,
} from "./outbound";
import { decodeRelay, encodeRelay } from "./relay";
import { DocumentStore } from "./store";
import type { CollabIo, CollabSocket, RelayKind } from "./types";

export interface CollabServer {
  readonly io: CollabIo;
  readonly httpServer: HttpServer;
  readonly port: number;
  readonly instanceId: string;
  readonly registry: DocumentRegistry;
  readonly store: DocumentStore;
  /** Counters that an operator watches; also served as text at /metrics. */
  metrics(): { rateLimiterEvictions: Record<string, number> };
  /** Stops accepting connections, writes what is queued and releases every resource. */
  close(): Promise<void>;
}

/** Extra bytes a Socket.IO packet adds around the payload (event name, framing). */
const FRAME_OVERHEAD_BYTES = 1024;
/** Real collaboration tokens are a few hundred bytes; longer ones are refused unparsed. */
export const MAX_TOKEN_CHARS = 2048;

/**
 * At shutdown, how long a client gets to close its socket before the connection is cut.
 * A client that does not read never answers the close handshake, and the documents are
 * written without waiting for it either way.
 */
const SHUTDOWN_SOCKET_GRACE_MS = 1000;

/**
 * How long a connection whose handshake was refused gets to read the refusal and close
 * before it is cut. The close is graceful so the client sees the error; a client that does
 * not read must not keep the connection open.
 */
const REFUSED_CLOSE_GRACE_MS = 1000;

/** How often every connection's queue is checked against the outbound caps. */
const QUEUE_SWEEP_INTERVAL_MS = 500;

/**
 * Warnings about connections the server closes for what they send are limited to this many
 * per second (a burst of 20), whatever the number of connections: a flood must not become
 * a flood of log lines. What was left out is counted in the next line.
 */
const CONNECTION_WARNINGS_PER_SECOND = 10;

/**
 * The namespace a Socket.IO CONNECT packet names, or null if the packet is not a CONNECT.
 * `data` is an Engine.IO message without its leading type character, so a CONNECT starts
 * with "0": then comes the namespace if it is not "/" ("0/chat,{...}"), or the auth
 * payload ("0{...}") or nothing for "/".
 */
export function connectNamespace(data: string): string | null {
  if (!data.startsWith("0")) return null;
  if (data[1] !== "/") return "/";
  const comma = data.indexOf(",");
  return comma === -1 ? data.slice(1) : data.slice(1, comma);
}

/** How long a command to Redis may take before it fails. */
const REDIS_COMMAND_TIMEOUT_MS = 1500;

function within<T>(promise: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Redis did not answer within ${ms} ms (${what})`)),
      ms,
    );
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Resolves when the client is ready; rejects if it is not within `ms`. */
function readyWithin(client: Redis, ms: number): Promise<void> {
  if (client.status === "ready") return Promise.resolve();
  return within(
    new Promise<void>((resolve) => client.once("ready", () => resolve())),
    ms,
    "connect",
  ).catch(() => {
    throw new Error(`could not connect to Redis within ${ms} ms`);
  });
}

/** The weaker of two roles; the order is the order of ROLES, strongest first. */
function weaker(a: Role, b: Role): Role {
  return ROLES.indexOf(a) >= ROLES.indexOf(b) ? a : b;
}

class HandshakeError extends Error {
  readonly data: { code: HandshakeErrorCode };
  constructor(code: HandshakeErrorCode) {
    super(code);
    this.data = { code };
  }
}

export async function startCollabServer(
  input: Parameters<typeof resolveOptions>[0],
): Promise<CollabServer> {
  const options: CollabServerOptions = resolveOptions(input);
  const { logger, limits } = options;
  const instanceId = options.instanceId ?? randomUUID().slice(0, 8);

  const store = new DocumentStore(options.databaseUrl);
  const httpServer = createServer((request, response) => {
    if (request.url === "/metrics") {
      const lines = Object.entries(rateLimiterEvictions()).map(
        ([name, count]) => `collabdocs_rate_limiter_evictions_total{limiter="${name}"} ${count}`,
      );
      response.writeHead(200, { "content-type": "text/plain; version=0.0.4" });
      response.end(
        [
          "# HELP collabdocs_rate_limiter_evictions_total Buckets dropped before they refilled, because the limiter was full of distinct keys.",
          "# TYPE collabdocs_rate_limiter_evictions_total counter",
          ...lines,
          "",
        ].join("\n"),
      );
      return;
    }
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    response.writeHead(404).end();
  });
  /** Every open TCP connection, so that shutdown can cut the ones a client keeps open. */
  const openConnections = new Set<NetSocket>();
  httpServer.on("connection", (connection) => {
    openConnections.add(connection);
    connection.once("close", () => openConnections.delete(connection));
  });
  const allowedOrigins = options.corsOrigin === undefined ? null : [options.corsOrigin].flat();
  /**
   * Whether a request may open a connection (the `cors` option below sets only the headers
   * of the answer to a browser's preflight). A request without an
   * Origin header does not come from a browser; the token is its credential. A browser
   * request must come from a configured origin, or, when none is configured, from the
   * server's own origin.
   */
  const originAllowed = (request: IncomingMessage): boolean => {
    const origin = request.headers.origin;
    if (origin === undefined) return true;
    if (allowedOrigins) return allowedOrigins.includes(origin);
    try {
      return new URL(origin).host === request.headers.host;
    } catch {
      return false;
    }
  };
  const io: CollabIo = new Server(httpServer, {
    maxHttpBufferSize: limits.maxUpdateBytes + FRAME_OVERHEAD_BYTES,
    // WebSocket only. A long-polling answer is handed to the HTTP layer as soon as it is
    // written, so the server could not see what a client that does not read has left in
    // its socket buffers: the queue bounds below hold only where the server can count.
    // The editor and the load generator ask for nothing else.
    transports: ["websocket"],
    cors: options.corsOrigin ? { origin: options.corsOrigin } : undefined,
    allowRequest: (request, callback) => {
      if (originAllowed(request)) return callback(null, true);
      logger.warn("connection refused: origin not allowed", {
        origin: String(request.headers.origin).slice(0, 200),
        instance: instanceId,
      });
      callback("origin not allowed", false);
    },
    // The editor sends Yjs binary; compression of small frames costs more than it saves.
    perMessageDeflate: false,
  });

  let suppressedWarnings = 0;
  const warningBudget = new RateLimiter(CONNECTION_WARNINGS_PER_SECOND, 20);
  /** A warning about a connection closed for what it sent; rate limited as a whole. */
  const warnAboutConnection = (message: string, fields: object = {}): void => {
    if (!warningBudget.allow()) {
      suppressedWarnings += 1;
      return;
    }
    logger.warn(message, {
      ...fields,
      instance: instanceId,
      ...(suppressedWarnings > 0 ? { suppressedSinceLast: suppressedWarnings } : {}),
    });
    suppressedWarnings = 0;
  };

  // Every Engine.IO connection, before it has joined anything and whether or not it ever
  // does. Socket.IO's own replies (to a CONNECT for a namespace that does not exist, to a
  // refused handshake) are not events and no budget below sees them, so the connection is
  // limited here: by what it sends, by the namespaces it may ask for and by what is queued.
  io.engine.on("connection", (conn: unknown) => {
    const packets = new RateLimiter(limits.maxPacketsPerSecond, limits.packetBurst);
    let closed = false;
    guardConnection(conn, (packet) => {
      if (closed) return;
      if (!packets.allow()) {
        closed = true;
        warnAboutConnection("too many packets from a connection; closing it");
        dropConnection(conn);
        return;
      }
      if (packet.type !== "message" || typeof packet.data !== "string") return;
      const namespace = connectNamespace(packet.data);
      if (namespace !== null && namespace !== "/") {
        closed = true;
        warnAboutConnection("connect to a namespace the server does not have; closing it", {
          namespace: namespace.slice(0, 64),
        });
        dropConnection(conn);
      }
    });
  });
  // The memory held for a connection is bounded for every connection, whether or not it
  // belongs to a document and whether or not anything is being sent to it: this finds the
  // ones that are over a cap and closes them.
  const sweepQueues = setInterval(() => {
    for (const conn of engineConnections(io.engine)) {
      // Over a cap is not enough: a client that reads a large reply at a normal rate is over
      // the byte cap for as long as the download takes. A connection is closed when it was
      // over a cap at the previous sweep too and the queue has not shrunk since.
      if (!stalledOverCap(conn, limits.maxOutboundBytes, limits.maxOutboundPackets)) continue;
      warnAboutConnection("outbound queue over the cap and not draining; closing the connection", {
        queuedBytes: queuedBytes(conn),
        queuedPackets: queuedPackets(conn),
      });
      dropConnection(conn);
    }
  }, QUEUE_SWEEP_INTERVAL_MS);
  sweepQueues.unref();

  const cleanups: Array<() => Promise<void>> = [];
  let rateLimiterEvictions = (): Record<string, number> => ({});
  let relay = (
    _documentId: string,
    _kind: RelayKind,
    _data: Uint8Array,
    _userId?: string,
  ): void => {};
  let counter: ConnectionCounter = new MemoryConnectionCounter(
    limits.maxConnectionsPerDocument,
    limits.maxConnectionsPerUser,
  );

  if (options.redisUrl) {
    const secret = options.redisMessageSecret!;
    const clients: Redis[] = [];
    const open = (label: string, extra: RedisOptions = {}): Redis => {
      const client = new Redis(options.redisUrl!, {
        connectTimeout: options.redisConnectTimeoutMs,
        ...extra,
      });
      client.on("error", (error) =>
        logger.error("redis error", { client: label, ...errorFields(error) }),
      );
      clients.push(client);
      return client;
    };
    try {
      // Commands fail at once while Redis is unreachable instead of waiting in a queue:
      // a handshake must be refused promptly, and a relay publish must not pile up.
      const pub = open("publisher", {
        enableOfflineQueue: false,
        commandTimeout: REDIS_COMMAND_TIMEOUT_MS,
      });
      // Subscribers resubscribe by themselves after a reconnect.
      const peers = open("relay");
      const members = open("membership");
      await Promise.all(
        clients.map((client) => readyWithin(client, options.redisConnectTimeoutMs)),
      );
      const relayChannel = `${options.adapterKey}:relay`;
      peers.on("messageBuffer", (_channel: Buffer, frame: Buffer) => {
        const message = decodeRelay(frame, secret);
        if (!message) {
          logger.warn(
            "ignored a relay frame that is malformed, stale or not signed with the secret",
          );
          return;
        }
        if (message.from === instanceId) return;
        registry.applyRemote(message.documentId, message.kind, message.data, message.userId);
      });
      members.on("message", (_channel: string, raw: string) => {
        const change = openMembershipChange(raw, secret);
        if (!change) {
          logger.warn("ignored a membership message that is malformed, stale or not signed");
          return;
        }
        registry.revoke(change);
      });
      await within(peers.subscribe(relayChannel), options.redisConnectTimeoutMs, "relay subscribe");
      await within(
        members.subscribe(options.membershipChannel),
        options.redisConnectTimeoutMs,
        "membership subscribe",
      );
      relay = (documentId, kind, data, userId) => {
        void pub
          .publish(
            relayChannel,
            encodeRelay(
              { from: instanceId, documentId, kind, data, ...(userId ? { userId } : {}) },
              secret,
            ),
          )
          .catch((error: unknown) =>
            logger.warn("relay publish failed", { documentId, ...errorFields(error) }),
          );
      };
      counter = new RedisConnectionCounter(
        pub,
        options.adapterKey,
        limits.maxConnectionsPerDocument,
        options.connectionTtlMs,
        limits.maxConnectionsPerUser,
        logger,
      );
    } catch (error) {
      clearInterval(sweepQueues);
      for (const client of clients) client.disconnect();
      await store.close();
      throw error;
    }
    cleanups.push(async () => {
      for (const client of clients) client.disconnect();
    });
  }
  cleanups.push(async () => counter.close());

  const registry = new DocumentRegistry({
    io,
    store,
    logger,
    persistence: options.persistence,
    limits,
    // The most a single reply can cost is half a bucket: a document larger than the burst
    // must still be openable by a socket whose bucket is full, and a full bucket is
    // already a few bytes short once the three-byte request that asked for the reply has
    // been counted (a refill takes a whole millisecond to show).
    chargeOutbound: (socket, bytes) =>
      socket.data.byteBudget.allow(Math.min(bytes, limits.byteBurst / 2)) &&
      bytesByUser.allow(socket.data.userId, Math.min(bytes, limits.byteBurstPerUser / 2)),
    relay: (documentId, kind, data, userId) => {
      try {
        relay(documentId, kind, data, userId);
      } catch (error) {
        logger.warn("relay failed", { documentId, kind, ...errorFields(error) });
      }
    },
  });

  // Limits that hold for a user or an address however many sockets they open. Per instance.
  const maxKeys = options.rateLimiterMaxKeys;
  const handshakesByIp = new KeyedRateLimiter(
    limits.handshakesPerSecondPerIp,
    limits.handshakeBurstPerIp,
    Date.now,
    maxKeys,
  );
  const handshakesByUser = new KeyedRateLimiter(
    limits.handshakesPerSecondPerUser,
    limits.handshakeBurstPerUser,
    Date.now,
    maxKeys,
  );
  const bytesByUser = new KeyedRateLimiter(
    limits.maxBytesPerSecondPerUser,
    limits.byteBurstPerUser,
    Date.now,
    maxKeys,
  );
  rateLimiterEvictions = () => ({
    handshakes_by_address: handshakesByIp.evictions,
    handshakes_by_user: handshakesByUser.evictions,
    bytes_by_user: bytesByUser.evictions,
  });
  let warnedForwarded = false;
  /** Payload bytes received and not yet processed, over every socket of this instance. */
  let inFlightBytes = 0;

  /** Connections whose refused handshake has been logged. */
  const refusalLogged = new WeakSet<object>();

  // The handshake: token, membership, capacity. Nothing else runs for a socket that fails here.
  io.use(async (socket, next) => {
    // A refused handshake ends the connection: the client has no document to be in and no
    // reason to keep a transport open, and an unauthenticated connection may not collect
    // refusals. Closing is deferred so that Socket.IO writes the error first (it does so
    // on the next tick), and is graceful so that the client reads it; a client that does
    // not read is cut after a grace period. One warning per connection, and a limited
    // number overall.
    const closeAfterRefusal = () => {
      setImmediate(() => {
        socket.conn.close();
        setTimeout(() => dropConnection(socket.conn), REFUSED_CLOSE_GRACE_MS).unref();
      });
    };
    const refuse = (code: HandshakeErrorCode, why: string, fields: object = {}) => {
      if (!refusalLogged.has(socket.conn)) {
        refusalLogged.add(socket.conn);
        warnAboutConnection("handshake refused", { code, why, ...fields });
      }
      next(new HandshakeError(code));
      closeAfterRefusal();
    };
    // The transport's close is the one signal that a client left during the handshake
    // (`disconnect` does not fire before the handshake completes). It is registered before
    // any await: a slot taken after the client left is released as soon as it is known.
    let slot: { documentId: string; userId: string } | null = null;
    let gone = false;
    socket.conn.once("close", () => {
      gone = true;
      if (slot) void counter.leave(slot.documentId, socket.id, slot.userId);
    });
    try {
      if (
        !options.trustedProxyHopsConfigured &&
        options.trustedProxyHops === 0 &&
        !warnedForwarded &&
        socket.handshake.headers["x-forwarded-for"] !== undefined
      ) {
        warnedForwarded = true;
        logger.warn(
          "a handshake carries X-Forwarded-For but COLLAB_TRUSTED_PROXY_HOPS is not set: every client behind the proxy is counted as the proxy's address. Set it to the number of proxies in front of this server.",
          { instance: instanceId },
        );
      }
      const auth: unknown = socket.handshake.auth;
      const { token, documentId } = (typeof auth === "object" && auth !== null ? auth : {}) as {
        token?: unknown;
        documentId?: unknown;
      };
      if (
        typeof token !== "string" ||
        typeof documentId !== "string" ||
        documentId === "" ||
        documentId.length > 128
      ) {
        return refuse("invalid_token", "missing token or document id");
      }
      // Before any parsing or signature check: unauthenticated input of any size that fits
      // in the connect packet must not buy decode and HMAC work.
      if (token.length > MAX_TOKEN_CHARS) {
        return refuse("invalid_token", "token is too long", { documentId });
      }
      let claims;
      try {
        claims = await verifyCollabToken({ token, secret: options.tokenSecret, documentId });
      } catch (error) {
        const why = error instanceof Error ? error.message : "invalid";
        return refuse("invalid_token", why, { documentId });
      }
      // Only a handshake with a valid token counts against an address, and the ceiling is
      // high: garbage from one client, or one busy address, cannot use up the budget that
      // other users behind the same proxy need. The per-user limit is the tight one.
      const address = clientAddress(
        socket.handshake.address,
        socket.handshake.headers["x-forwarded-for"],
        options.trustedProxyHops,
      );
      if (!handshakesByIp.allow(address)) {
        return refuse("rate_limited", "too many handshakes from this address", {
          address,
          documentId,
        });
      }
      if (!handshakesByUser.allow(claims.userId)) {
        return refuse("rate_limited", "too many handshakes from this user", {
          documentId,
          userId: claims.userId,
        });
      }
      // A token cannot be revoked, so the membership is looked up again.
      const memberRole = await store.role(documentId, claims.userId);
      if (!memberRole) {
        return refuse("not_a_member", "membership no longer exists", {
          documentId,
          userId: claims.userId,
        });
      }
      // Check and count in one step, so concurrent handshakes cannot overshoot the limit.
      const joined = await counter.join(
        documentId,
        socket.id,
        claims.userId,
        () => socket.conn.readyState === "open",
      );
      if (joined !== "ok") {
        return refuse(
          "too_many_connections",
          joined === "user_full" ? "user is at capacity" : "document is at capacity",
          { documentId, userId: claims.userId },
        );
      }
      slot = { documentId, userId: claims.userId };
      if (gone || socket.conn.readyState !== "open") {
        // The client left while the slot was being taken.
        await counter.leave(documentId, socket.id, claims.userId);
        return refuse("server_error", "client left during the handshake", { documentId });
      }
      socket.data = {
        documentId,
        userId: claims.userId,
        name: claims.name,
        role: weaker(claims.role, memberRole),
        memberRole,
        roleCheckedAt: Date.now(),
        byteBudget: new RateLimiter(limits.maxBytesPerSecond, limits.byteBurst),
        origin: {
          kind: "client",
          socketId: socket.id,
          userId: claims.userId,
          awarenessIds: new Set(),
        },
      };
      next();
    } catch (error) {
      logger.error("handshake failed", errorFields(error));
      next(new HandshakeError("server_error"));
      closeAfterRefusal();
    }
  });

  io.on("connection", (socket: CollabSocket) => {
    const { documentId, userId, role, byteBudget } = socket.data;
    const limiter = new RateLimiter(limits.maxMessagesPerSecond, limits.messageBurst);
    logger.info("socket connected", { documentId, userId, role, instance: instanceId });

    // Load (or find) the document. Events that arrive meanwhile wait on this promise,
    // so they run in the order they came.
    const attached = registry.acquire(documentId).then(async (entry) => {
      if (socket.disconnected) return null;
      // The membership may have changed while the handshake and the load were running.
      if (!(await entry.confirmRole(socket, true)) || socket.disconnected) return null;
      entry.attach(socket);
      return entry;
    });
    attached.catch((error) => {
      logger.error("could not load the document", { documentId, ...errorFields(error) });
      socket.disconnect(true);
    });

    // One event at a time per socket, in arrival order, even when a handler waits.
    let tail: Promise<void> = attached.then(
      () => {},
      () => {},
    );
    const onEvent =
      (handle: "onSync" | "onAwareness") =>
      (payload: unknown): void => {
        // Both budgets are checked on arrival, before anything is queued, so a flood
        // while the document loads cannot grow memory.
        if (!limiter.allow()) {
          logger.warn("rate limit exceeded; disconnecting", { documentId, userId });
          socket.disconnect(true);
          return;
        }
        const cost = payloadBytes(payload);
        // The user's budget is shared by all their sockets, so opening more of them,
        // or reconnecting, does not buy a fresh burst.
        if (!byteBudget.allow(cost) || !bytesByUser.allow(userId, cost)) {
          logger.warn("byte budget exceeded; disconnecting", { documentId, userId });
          socket.disconnect(true);
          return;
        }
        if (inFlightBytes + cost > limits.maxInFlightBytes) {
          logger.warn("too many payload bytes in flight; disconnecting", { documentId, userId });
          socket.disconnect(true);
          return;
        }
        inFlightBytes += cost;
        tail = tail.then(async () => {
          try {
            const entry = await attached;
            if (entry && socket.connected) await entry[handle](socket, payload);
          } catch (error) {
            logger.error("event failed", { documentId, ...errorFields(error) });
          } finally {
            inFlightBytes -= cost;
          }
        });
      };
    // Only two events exist. Any other name would reach no handler and so no limit; a
    // client that sends one is not an editor, and is closed.
    socket.use(([event], next) => {
      if (event === COLLAB_EVENTS.sync || event === COLLAB_EVENTS.awareness) return next();
      logger.warn("unknown event; disconnecting", {
        documentId,
        userId,
        event: String(event).slice(0, 64),
      });
      socket.disconnect(true);
    });
    socket.on(COLLAB_EVENTS.sync, onEvent("onSync"));
    socket.on(COLLAB_EVENTS.awareness, onEvent("onAwareness"));

    socket.on("disconnect", (reason) => {
      logger.info("socket disconnected", { documentId, userId, reason });
      void attached.then(
        (entry) => entry?.detach(socket),
        () => {},
      );
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port, options.host, () => resolve());
  });
  const port = (httpServer.address() as AddressInfo).port;
  logger.info("collab server listening", { port, instance: instanceId });

  let closing: Promise<void> | null = null;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      // The documents are written while the sockets close, not after: a client that does
      // not read keeps its socket open until the transport is cut, and must not delay
      // persistence. Sockets that are still open after the grace period are cut.
      clearInterval(sweepQueues);
      const cut = setTimeout(() => {
        // Engine.IO has already let go of these sockets, but the TCP connection stays
        // until the peer answers the close handshake (30 s in `ws`).
        for (const connection of openConnections) connection.destroy();
      }, SHUTDOWN_SOCKET_GRACE_MS);
      try {
        await Promise.all([io.close(), registry.closeAll()]);
      } finally {
        clearTimeout(cut);
      }
      await store.close();
      for (const cleanup of cleanups) await cleanup();
    })();
    return closing;
  };

  return {
    io,
    httpServer,
    port,
    instanceId,
    registry,
    store,
    metrics: () => ({ rateLimiterEvictions: rateLimiterEvictions() }),
    close,
  };
}
