import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { RedisConnectionCounter } from "../src/connections";
import {
  TestClient,
  adapterKey,
  captureLogger,
  cleanup,
  closeDb,
  connectErrorOf,
  createDocument,
  launch,
  redisClient,
  resetDb,
  settle,
  waitFor,
} from "./support";

beforeEach(resetDb);
afterEach(cleanup);
afterAll(closeDb);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Makes the membership lookup of the handshake slow, so that a client can leave while it runs. */
function slowRoleLookup(server: Awaited<ReturnType<typeof launch>>, ms: number): void {
  const real = server.store.role.bind(server.store);
  server.store.role = async (documentId, userId) => {
    await sleep(ms);
    return real(documentId, userId);
  };
}

describe("a connection slot is released on every path", () => {
  for (const redis of [false, true]) {
    it(`frees the slot of a client that leaves during the handshake (${redis ? "Redis" : "memory"})`, async () => {
      const server = await launch({
        redis,
        connectionTtlMs: 600,
        limits: { maxConnectionsPerDocument: 3 },
      });
      const f = await createDocument();
      slowRoleLookup(server, 100);
      for (let i = 0; i < 3; i += 1) {
        const leaver = await TestClient.connect(server, f, "owner", "owner", { noWait: true });
        await sleep(30);
        leaver.close();
      }
      // Longer than the handshakes and, in Redis mode, several heartbeats and expiries.
      await settle(redis ? 3000 : 600);
      const client = await TestClient.connect(server, f, "editor", "editor");
      expect(client.connected).toBe(true);
    });
  }
});

describe("the heartbeat", () => {
  it("keeps the slot of a socket that stays connected beyond the expiry", async () => {
    const server = await launch({
      redis: true,
      connectionTtlMs: 600,
      limits: { maxConnectionsPerDocument: 1 },
    });
    const f = await createDocument();
    await TestClient.connect(server, f, "owner", "owner");
    await settle(2500);
    expect((await connectErrorOf(server, f, "editor", "editor")).code).toBe("too_many_connections");
  });

  it("puts back a slot that expired or vanished while its socket is still connected", async () => {
    const server = await launch({
      redis: true,
      connectionTtlMs: 600,
      limits: { maxConnectionsPerDocument: 1 },
    });
    const f = await createDocument();
    await TestClient.connect(server, f, "owner", "owner");
    // A Redis restart or flush: the entry is gone.
    await redisClient().del(`${adapterKey()}:conn:${f.documentId}`);
    await settle(1200);
    expect((await connectErrorOf(server, f, "editor", "editor")).code).toBe("too_many_connections");
  });

  it("releases, instead of refreshing, a slot whose socket is no longer connected", async () => {
    const redis = redisClient();
    const prefix = `test-counter-${randomUUID().slice(0, 8)}`;
    const counter = new RedisConnectionCounter(redis, prefix, 10, 300, 10, captureLogger());
    try {
      let alive = true;
      expect(await counter.join("doc", "socket", "user", () => alive)).toBe("ok");
      await settle(500);
      expect(await redis.zcard(`${prefix}:conn:doc`)).toBe(1);
      alive = false;
      await settle(500);
      expect(await redis.zcard(`${prefix}:conn:doc`)).toBe(0);
    } finally {
      counter.close();
      await redis.del(`${prefix}:conn:doc`, `${prefix}:conn:doc:user:user`);
    }
  });

  it("refreshes many documents in one round, not one after another", async () => {
    const real = redisClient();
    const prefix = `test-counter-${randomUUID().slice(0, 8)}`;
    // Every command takes 100 ms. Refreshed one by one, 20 documents need 2 s: more than the 600 ms expiry.
    const slow = new Proxy(real, {
      get(target, property) {
        const value = Reflect.get(target, property, target) as unknown;
        if (property !== "eval" || typeof value !== "function") return value;
        return async (...args: unknown[]) => {
          await sleep(100);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
    const counter = new RedisConnectionCounter(slow, prefix, 10, 600, 10, captureLogger());
    try {
      for (let i = 0; i < 20; i += 1) {
        await counter.join(`doc${i}`, `socket${i}`, "user", () => true);
      }
      await settle(2500);
      const sizes = await Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          real.zcount(`${prefix}:conn:doc${i}`, Date.now(), "+inf"),
        ),
      );
      expect(sizes.filter((n) => n === 1)).toHaveLength(20);
    } finally {
      counter.close();
      for (let i = 0; i < 20; i += 1) {
        await real.del(`${prefix}:conn:doc${i}`, `${prefix}:conn:doc${i}:user:user`);
      }
    }
  });
});

describe("limits that are per user, not per socket", () => {
  it("caps the sockets one user may hold on a document", async () => {
    const server = await launch({ limits: { maxConnectionsPerUser: 2 } });
    const f = await createDocument();
    await TestClient.connect(server, f, "owner", "owner");
    await TestClient.connect(server, f, "owner", "owner");
    expect((await connectErrorOf(server, f, "owner", "owner")).code).toBe("too_many_connections");
    // Someone else is not affected.
    const editor = await TestClient.connect(server, f, "editor", "editor");
    expect(editor.connected).toBe(true);
  });

  it("counts a user's sockets across instances and frees a place when one leaves", async () => {
    const a = await launch({ redis: true, instanceId: "A", limits: { maxConnectionsPerUser: 2 } });
    const b = await launch({ redis: true, instanceId: "B", limits: { maxConnectionsPerUser: 2 } });
    const f = await createDocument();
    const first = await TestClient.connect(a, f, "owner", "owner");
    await TestClient.connect(b, f, "owner", "owner");
    expect((await connectErrorOf(a, f, "owner", "owner")).code).toBe("too_many_connections");
    expect((await connectErrorOf(b, f, "owner", "owner")).code).toBe("too_many_connections");
    first.close();
    await settle(300);
    expect((await TestClient.connect(b, f, "owner", "owner")).connected).toBe(true);
  });

  it("rate limits handshakes per user, so reconnecting does not reset anything", async () => {
    const server = await launch({
      limits: { handshakeBurstPerUser: 3, handshakesPerSecondPerUser: 0.5 },
    });
    const f = await createDocument();
    for (let i = 0; i < 3; i += 1) {
      const client = await TestClient.connect(server, f, "owner", "owner");
      client.close();
    }
    expect((await connectErrorOf(server, f, "owner", "owner")).code).toBe("rate_limited");
    // Another user has a bucket of their own.
    expect((await TestClient.connect(server, f, "editor", "editor")).connected).toBe(true);
  });

  it("rate limits handshakes per address, whoever the user is", async () => {
    const server = await launch({
      limits: { handshakeBurstPerIp: 2, handshakesPerSecondPerIp: 0.5 },
    });
    const f = await createDocument();
    await TestClient.connect(server, f, "owner", "owner");
    await TestClient.connect(server, f, "editor", "editor");
    expect((await connectErrorOf(server, f, "viewer", "viewer")).code).toBe("rate_limited");
  });

  it("reads the client address from X-Forwarded-For only behind trusted proxies", async () => {
    const f = await createDocument();
    const behind = await launch({
      trustedProxyHops: 1,
      limits: { handshakeBurstPerIp: 1, handshakesPerSecondPerIp: 0.01 },
    });
    // Two handshakes from one machine, but the proxy says they are two different clients.
    const connectVia = async (address: string, who: "owner" | "editor") => {
      const { io: connect } = await import("socket.io-client");
      const { mintToken } = await import("./support");
      const socket = connect(`http://127.0.0.1:${behind.port}`, {
        auth: {
          token: await mintToken(f.documentId, f.users[who]!, who),
          documentId: f.documentId,
        },
        transports: ["websocket"],
        reconnection: false,
        forceNew: true,
        extraHeaders: { "x-forwarded-for": `6.6.6.6, ${address}` },
      });
      const outcome = await new Promise<string>((resolve) => {
        socket.on("connect", () => resolve("connected"));
        socket.on("connect_error", (error: Error & { data?: { code?: string } }) =>
          resolve(error.data?.code ?? error.message),
        );
      });
      socket.close();
      return outcome;
    };
    expect(await connectVia("10.0.0.1", "owner")).toBe("connected");
    expect(await connectVia("10.0.0.2", "editor")).toBe("connected");
    // The same address again: refused. A client's own leading entry does not help it.
    expect(await connectVia("10.0.0.1", "owner")).toBe("rate_limited");
  });

  it("shares one byte budget between all sockets of a user", async () => {
    const server = await launch({
      limits: {
        maxUpdateBytes: 5000,
        maxBytesPerSecond: 100_000,
        byteBurst: 100_000,
        maxBytesPerSecondPerUser: 1000,
        byteBurstPerUser: 10_000,
        maxMessagesPerSecond: 1000,
        messageBurst: 1000,
      },
    });
    const f = await createDocument();
    const one = await TestClient.connect(server, f, "owner", "owner");
    const two = await TestClient.connect(server, f, "owner", "owner");
    // Each socket stays under its own budget; together they pass the user's.
    for (let i = 0; i < 2; i += 1) {
      one.append("x".repeat(3000));
      two.append("y".repeat(3000));
    }
    await waitFor(() => !one.connected || !two.connected, "a socket to be disconnected");
    expect(server.logs.find("byte budget exceeded; disconnecting").length).toBeGreaterThan(0);
  });

  it("closes a socket when too many payload bytes are in flight on the instance", async () => {
    const server = await launch({
      limits: { maxUpdateBytes: 5000, maxInFlightBytes: 6000, maxPendingBytes: 1_000_000 },
      persistence: {
        roleCacheMs: 1,
        reconcileIntervalMs: 60_000,
        membershipRecheckMs: 60_000,
        unloadGraceMs: 60_000,
      },
    });
    const f = await createDocument();
    const writer = await TestClient.connect(server, f, "owner", "owner");
    // A slow membership check keeps the payloads queued.
    const real = server.store.role.bind(server.store);
    server.store.role = async (documentId, userId) => {
      await sleep(500);
      return real(documentId, userId);
    };
    for (let i = 0; i < 4; i += 1) writer.append("z".repeat(2500));
    await waitFor(() => !writer.connected, "the writer to be disconnected");
    expect(server.logs.find("too many payload bytes in flight; disconnecting")).toHaveLength(1);
  });
});

/** One handshake with a header and an auth payload of the test's choosing; the outcome is the error code or "connected". */
async function handshake(
  server: Awaited<ReturnType<typeof launch>>,
  auth: Record<string, unknown>,
  headers: Record<string, string> = {},
): Promise<string> {
  const { io: connect } = await import("socket.io-client");
  const socket = connect(`http://127.0.0.1:${server.port}`, {
    auth,
    transports: ["websocket"],
    reconnection: false,
    forceNew: true,
    extraHeaders: headers,
  });
  const outcome = await new Promise<string>((resolve) => {
    socket.on("connect", () => resolve("connected"));
    socket.on("connect_error", (error: Error & { data?: { code?: string } }) =>
      resolve(error.data?.code ?? error.message),
    );
  });
  socket.close();
  return outcome;
}

describe("one anonymous client cannot lock out the others behind the same address", () => {
  it("does not count a handshake without a valid token against the address", async () => {
    // A proxy that is not configured: every client has the proxy's address. The address
    // ceiling is set low here to make the point with a few handshakes.
    const server = await launch({
      limits: { handshakeBurstPerIp: 3, handshakesPerSecondPerIp: 0.01 },
    });
    const f = await createDocument();
    for (let i = 0; i < 12; i += 1) {
      expect(await handshake(server, { token: "garbage", documentId: f.documentId })).toBe(
        "invalid_token",
      );
    }
    expect(await handshake(server, {})).toBe("invalid_token");
    // A real user still gets in.
    const { mintToken } = await import("./support");
    const token = await mintToken(f.documentId, f.users.owner!, "owner");
    expect(await handshake(server, { token, documentId: f.documentId })).toBe("connected");
  });

  it("refuses a token over the size cap even when its signature is valid", async () => {
    const server = await launch();
    const f = await createDocument();
    const { signCollabToken } = await import("@collabdocs/shared");
    const { TOKEN_SECRET } = await import("./support");
    // Correctly signed, but padded through the subject claim: only the cap can refuse it.
    const { token } = await signCollabToken({
      documentId: f.documentId,
      userId: `${f.users.owner!}${"x".repeat(3000)}`,
      role: "owner",
      secret: TOKEN_SECRET,
    });
    expect(token.length).toBeGreaterThan(2048);
    expect(await handshake(server, { token, documentId: f.documentId })).toBe("invalid_token");
  });

  it("still holds the address ceiling for handshakes with valid tokens", async () => {
    const server = await launch({
      limits: { handshakeBurstPerIp: 2, handshakesPerSecondPerIp: 0.01 },
    });
    const f = await createDocument();
    const { mintToken } = await import("./support");
    const outcomes: string[] = [];
    for (const who of ["owner", "editor", "viewer"] as const) {
      const token = await mintToken(f.documentId, f.users[who]!, who);
      outcomes.push(await handshake(server, { token, documentId: f.documentId }));
    }
    expect(outcomes).toEqual(["connected", "connected", "rate_limited"]);
  });

  it("has an address ceiling by default that a whole office behind one address does not reach", async () => {
    const { DEFAULT_LIMITS } = await import("../src/config");
    expect(DEFAULT_LIMITS.handshakeBurstPerIp).toBeGreaterThanOrEqual(1000);
    expect(DEFAULT_LIMITS.handshakeBurstPerIp).toBeGreaterThan(
      DEFAULT_LIMITS.handshakeBurstPerUser * 50,
    );
  });
});

describe("the proxy warning", () => {
  const forwarded = { "x-forwarded-for": "203.0.113.9" };
  const warnings = (server: Awaited<ReturnType<typeof launch>>) =>
    server.logs.records.filter((r) => r.level === "warn" && r.message.includes("X-Forwarded-For"));

  it("warns once when requests carry X-Forwarded-For and the hop count was never set", async () => {
    const server = await launch();
    const f = await createDocument();
    await handshake(server, { token: "x", documentId: f.documentId });
    expect(warnings(server)).toHaveLength(0);
    await handshake(server, { token: "x", documentId: f.documentId }, forwarded);
    await handshake(server, { token: "x", documentId: f.documentId }, forwarded);
    expect(warnings(server)).toHaveLength(1);
    expect(String(warnings(server)[0]!.message)).toContain("COLLAB_TRUSTED_PROXY_HOPS");
  });

  it("is silent when the operator set the count, even to 0", async () => {
    const f = await createDocument();
    for (const hops of [0, 1]) {
      const server = await launch({ trustedProxyHops: hops });
      await handshake(server, { token: "x", documentId: f.documentId }, forwarded);
      expect(warnings(server)).toHaveLength(0);
    }
  });
});

describe("the rate limiter metric", () => {
  it("counts evictions and serves them at /metrics", async () => {
    const server = await launch({ rateLimiterMaxKeys: 2 });
    const f = await createDocument();
    const { mintToken } = await import("./support");
    for (const who of ["owner", "editor", "viewer"] as const) {
      const token = await mintToken(f.documentId, f.users[who]!, who);
      expect(await handshake(server, { token, documentId: f.documentId })).toBe("connected");
    }
    expect(server.metrics().rateLimiterEvictions.handshakes_by_user).toBe(1);
    const text = await (await fetch(`http://127.0.0.1:${server.port}/metrics`)).text();
    expect(text).toContain(
      'collabdocs_rate_limiter_evictions_total{limiter="handshakes_by_user"} 1',
    );
  });
});
