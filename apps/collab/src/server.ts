import { createServer, type Server as HttpServer } from "node:http";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import {
  COLLAB_EVENTS,
  ROLES,
  parseMembershipChange,
  verifyCollabToken,
  type HandshakeErrorCode,
  type Role,
} from "@collabdocs/shared";
import { createAdapter } from "@socket.io/redis-adapter";
import { Redis } from "ioredis";
import { Server } from "socket.io";
import { resolveOptions, type CollabServerOptions } from "./config";
import { DocumentRegistry } from "./document";
import { errorFields } from "./logger";
import { RateLimiter, payloadBytes } from "./limits";
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
  /** Stops accepting connections, writes what is queued and releases every resource. */
  close(): Promise<void>;
}

/** Extra bytes a Socket.IO packet adds around the payload (event name, framing). */
const FRAME_OVERHEAD_BYTES = 1024;

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
    if (request.url === "/healthz") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end('{"ok":true}');
      return;
    }
    response.writeHead(404).end();
  });
  const io: CollabIo = new Server(httpServer, {
    maxHttpBufferSize: limits.maxUpdateBytes + FRAME_OVERHEAD_BYTES,
    cors: options.corsOrigin ? { origin: options.corsOrigin } : undefined,
    // The editor sends Yjs binary; compression of small frames costs more than it saves.
    perMessageDeflate: false,
  });

  const cleanups: Array<() => Promise<void>> = [];
  let relay = (_documentId: string, _kind: RelayKind, _data: Uint8Array): void => {};

  if (options.redisUrl) {
    const pub = new Redis(options.redisUrl);
    const sub = pub.duplicate();
    const members = pub.duplicate();
    for (const client of [pub, sub, members]) {
      client.on("error", (error) => logger.error("redis error", errorFields(error)));
    }
    // The adapter answers cluster-wide questions about rooms (the connection limit).
    io.adapter(createAdapter(pub, sub, { key: options.adapterKey }));
    // Yjs traffic between instances goes over a channel of our own, in binary.
    const relayChannel = `${options.adapterKey}:relay`;
    const peers = pub.duplicate();
    peers.on("error", (error) => logger.error("redis error", errorFields(error)));
    peers.on("messageBuffer", (_channel: Buffer, frame: Buffer) => {
      const message = decodeRelay(frame);
      if (!message) {
        logger.warn("ignored a malformed relay frame");
        return;
      }
      if (message.from === instanceId) return;
      registry.applyRemote(message.documentId, message.kind, message.data);
    });
    await peers.subscribe(relayChannel);
    relay = (documentId, kind, data) => {
      void pub
        .publish(relayChannel, encodeRelay({ from: instanceId, documentId, kind, data }))
        .catch((error: unknown) =>
          logger.warn("relay publish failed", { documentId, ...errorFields(error) }),
        );
    };
    members.on("message", (_channel: string, raw: string) => {
      const change = parseMembershipChange(raw);
      if (!change) {
        logger.warn("ignored a malformed membership message");
        return;
      }
      registry.revoke(change);
    });
    await members.subscribe(options.membershipChannel);
    cleanups.push(async () => {
      for (const client of [pub, sub, members, peers]) client.disconnect();
    });
  }

  const registry = new DocumentRegistry({
    io,
    store,
    logger,
    persistence: options.persistence,
    limits,
    relay: (documentId, kind, data) => {
      try {
        relay(documentId, kind, data);
      } catch (error) {
        logger.warn("relay failed", { documentId, kind, ...errorFields(error) });
      }
    },
  });

  // The handshake: token, membership, capacity. Nothing else runs for a socket that fails here.
  io.use(async (socket, next) => {
    const refuse = (code: HandshakeErrorCode, why: string, fields: object = {}) => {
      logger.warn("handshake refused", { code, why, instance: instanceId, ...fields });
      next(new HandshakeError(code));
    };
    try {
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
      let claims;
      try {
        claims = await verifyCollabToken({ token, secret: options.tokenSecret, documentId });
      } catch (error) {
        const why = error instanceof Error ? error.message : "invalid";
        return refuse("invalid_token", why, { documentId });
      }
      // A token cannot be revoked, so the membership is looked up again.
      const memberRole = await store.role(documentId, claims.userId);
      if (!memberRole) {
        return refuse("not_a_member", "membership no longer exists", {
          documentId,
          userId: claims.userId,
        });
      }
      // fetchSockets asks every instance behind the adapter, so the count is cluster-wide.
      const inRoom = await io.in(`doc:${documentId}`).fetchSockets();
      if (inRoom.length >= limits.maxConnectionsPerDocument) {
        return refuse("too_many_connections", "document is at capacity", { documentId });
      }
      socket.data = {
        documentId,
        userId: claims.userId,
        role: weaker(claims.role, memberRole),
        memberRole,
        origin: { kind: "client", socketId: socket.id, awarenessIds: new Set() },
      };
      next();
    } catch (error) {
      logger.error("handshake failed", errorFields(error));
      next(new HandshakeError("server_error"));
    }
  });

  io.on("connection", (socket: CollabSocket) => {
    const { documentId, userId, role } = socket.data;
    const limiter = new RateLimiter(limits.maxMessagesPerSecond, limits.messageBurst);
    const byteBudget = new RateLimiter(limits.maxBytesPerSecond, limits.byteBurst);
    logger.info("socket connected", { documentId, userId, role, instance: instanceId });

    // Load (or find) the document. Events that arrive meanwhile wait on this promise,
    // so they run in the order they came.
    const attached = registry.acquire(documentId).then((entry) => {
      if (socket.disconnected) return null;
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
        if (!byteBudget.allow(payloadBytes(payload))) {
          logger.warn("byte budget exceeded; disconnecting", { documentId, userId });
          socket.disconnect(true);
          return;
        }
        tail = tail.then(async () => {
          try {
            const entry = await attached;
            if (entry && socket.connected) await entry[handle](socket, payload);
          } catch (error) {
            logger.error("event failed", { documentId, ...errorFields(error) });
          }
        });
      };
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
      await io.close();
      await registry.closeAll();
      await store.close();
      for (const cleanup of cleanups) await cleanup();
    })();
    return closing;
  };

  return { io, httpServer, port, instanceId, registry, store, close };
}
