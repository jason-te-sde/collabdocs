import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeyedRateLimiter, RateLimiter, clientAddress } from "../src/limits";
import {
  TestClient,
  adapterKey,
  cleanup,
  closeDb,
  connectErrorOf,
  createDocument,
  holdAppends,
  launch,
  redisClient,
  resetDb,
  settle,
  storedText,
  updateRows,
  waitFor,
} from "./support";

beforeEach(resetDb);
afterEach(cleanup);
afterAll(closeDb);

describe("RateLimiter", () => {
  it("allows a burst, then the sustained rate", () => {
    let now = 0;
    const limiter = new RateLimiter(10, 5, () => now);
    expect(Array.from({ length: 6 }, () => limiter.allow())).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    now += 100; // one token comes back
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(false);
    now += 10_000; // never more than the burst
    expect(Array.from({ length: 6 }, () => limiter.allow()).filter(Boolean)).toHaveLength(5);
  });
});

describe("KeyedRateLimiter", () => {
  it("gives each key its own bucket and stays bounded", () => {
    const now = 0;
    const limiter = new KeyedRateLimiter(1, 2, () => now, 3);
    expect([limiter.allow("a"), limiter.allow("a"), limiter.allow("a")]).toEqual([
      true,
      true,
      false,
    ]);
    expect(limiter.allow("b")).toBe(true);
    for (const key of ["c", "d", "e", "f", "g"]) limiter.allow(key);
    expect(limiter.size).toBeLessThanOrEqual(3);
  });
});

describe("KeyedRateLimiter under a flood of keys", () => {
  it("evicts the least recently used key, so a client that keeps sending keeps its bucket", () => {
    const now = 0;
    const limiter = new KeyedRateLimiter(0.001, 2, () => now, 4);
    // "live" has spent its burst; it keeps asking, so it stays recent.
    expect(limiter.allow("live", 2)).toBe(true);
    for (let i = 0; i < 50; i += 1) {
      limiter.allow(`flood-${i}`, 2);
      expect(limiter.allow("live")).toBe(false);
    }
    expect(limiter.size).toBeLessThanOrEqual(4);
  });

  it("counts evictions of buckets that were not full, and not of the ones that were", () => {
    let now = 0;
    const limiter = new KeyedRateLimiter(1, 2, () => now, 2);
    limiter.allow("a", 2);
    limiter.allow("b", 2);
    limiter.allow("c", 2); // a goes, with a deficit
    expect(limiter.evictions).toBe(1);
    now += 10_000; // everything has refilled
    limiter.allow("d");
    limiter.allow("e");
    expect(limiter.evictions).toBe(1);
  });

  it("holds memory at the cap however many keys arrive", () => {
    const limiter = new KeyedRateLimiter(1, 1, () => 0, 1000);
    for (let i = 0; i < 20_000; i += 1) limiter.allow(`k${i}`);
    expect(limiter.size).toBe(1000);
    expect(limiter.evictions).toBe(19_000);
  });
});

describe("clientAddress", () => {
  it("believes X-Forwarded-For only behind trusted proxies, counting from the end", () => {
    expect(clientAddress("10.0.0.9", "1.1.1.1, 2.2.2.2", 0)).toBe("10.0.0.9");
    expect(clientAddress("10.0.0.9", "1.1.1.1, 2.2.2.2", 1)).toBe("2.2.2.2");
    expect(clientAddress("10.0.0.9", "1.1.1.1, 2.2.2.2", 2)).toBe("1.1.1.1");
    expect(clientAddress("10.0.0.9", undefined, 1)).toBe("10.0.0.9");
    expect(clientAddress("10.0.0.9", "2.2.2.2", 3)).toBe("10.0.0.9");
  });

  it("groups an IPv6 address by its /64 and unwraps IPv4-mapped ones", () => {
    expect(clientAddress("2001:db8:1:2:aaaa:bbbb:cccc:dddd", undefined, 0)).toBe("2001:db8:1:2");
    expect(clientAddress("2001:db8:1:2::5", undefined, 0)).toBe("2001:db8:1:2");
    expect(clientAddress("2001:db8::1", undefined, 0)).toBe("2001:db8:0:0");
    expect(clientAddress("::ffff:10.1.2.3", undefined, 0)).toBe("10.1.2.3");
  });
});

describe("limits", () => {
  it("rejects an update over the size limit and leaves the state alone", async () => {
    const server = await launch({ limits: { maxUpdateBytes: 2000 } });
    const f = await createDocument();
    const a = await TestClient.connect(server, f, "owner", "owner");
    const b = await TestClient.connect(server, f, "editor", "editor");
    a.insert(0, "small");
    await waitFor(() => b.text === "small", "the small update");

    // Just over the limit but inside the transport's frame allowance: refused by the server.
    a.append("x".repeat(2100));
    await waitFor(() => a.rejected.length === 1, "a rejection");
    expect(a.rejected[0]).toEqual({ event: "sync", reason: "too_large" });
    expect(server.logs.find("message rejected")[0]).toMatchObject({ reason: "too_large" });
    await settle();
    expect(b.text).toBe("small");
    expect(await storedText(f.documentId)).toBe("small");
    expect(await updateRows(f.documentId)).toHaveLength(1);
    expect(a.connected).toBe(true);
  });

  it("closes a connection that sends a frame far over the limit", async () => {
    const server = await launch({ limits: { maxUpdateBytes: 2000 } });
    const f = await createDocument();
    const a = await TestClient.connect(server, f, "owner", "owner");
    const b = await TestClient.connect(server, f, "editor", "editor");
    a.append("y".repeat(20_000));
    await waitFor(() => !a.connected, "the connection to be closed");
    await settle();
    expect(b.text).toBe("");
    expect(await updateRows(f.documentId)).toHaveLength(0);
  });

  it("applies the size limit to awareness updates too", async () => {
    const server = await launch({ limits: { maxAwarenessBytes: 2000 } });
    const f = await createDocument();
    const a = await TestClient.connect(server, f, "owner", "owner");
    const b = await TestClient.connect(server, f, "editor", "editor");
    a.awareness.setLocalState({ blob: "z".repeat(2100) });
    await waitFor(() => a.rejected.length === 1, "a rejection");
    expect(a.rejected[0]).toEqual({ event: "awareness", reason: "too_large" });
    await settle();
    expect(b.awareness.getStates().size).toBe(0);
  });

  it("disconnects a socket that sends messages faster than the rate limit", async () => {
    const server = await launch({ limits: { maxMessagesPerSecond: 5, messageBurst: 10 } });
    const f = await createDocument();
    const flooder = await TestClient.connect(server, f, "owner", "owner");
    const other = await TestClient.connect(server, f, "editor", "editor");
    for (let i = 0; i < 50; i += 1) flooder.awareness.setLocalState(flooder.state({ i }));
    await waitFor(() => !flooder.connected, "the flooder to be disconnected");
    expect(server.logs.find("rate limit exceeded; disconnecting")).toHaveLength(1);
    expect(other.connected).toBe(true);
    // The other client is unaffected and the flooder may come back and sync again.
    const again = await TestClient.connect(server, f, "owner", "owner");
    other.insert(0, "fine");
    await waitFor(() => again.text === "fine", "normal traffic");
  });

  it("refuses a connection beyond the per-document maximum", async () => {
    const server = await launch({ limits: { maxConnectionsPerDocument: 2 } });
    const f = await createDocument();
    const a = await TestClient.connect(server, f, "owner", "owner");
    await TestClient.connect(server, f, "editor", "editor");
    const refused = await connectErrorOf(server, f, "viewer", "viewer");
    expect(refused.code).toBe("too_many_connections");

    // Another document is not affected, and a freed place can be taken.
    const g = await createDocument();
    await TestClient.connect(server, g, "owner", "owner");
    a.close();
    await settle(150);
    const viewer = await TestClient.connect(server, f, "viewer", "viewer");
    expect(viewer.connected).toBe(true);
  });
});

describe("one editor cannot exhaust the server", () => {
  it("disconnects a socket that sends more bytes than its budget, however few messages", async () => {
    const server = await launch({
      limits: {
        maxUpdateBytes: 5000,
        maxBytesPerSecond: 1000,
        byteBurst: 10_000,
        maxMessagesPerSecond: 1000,
        messageBurst: 1000,
      },
    });
    const f = await createDocument();
    const writer = await TestClient.connect(server, f, "owner", "owner");
    const other = await TestClient.connect(server, f, "editor", "editor");
    for (let i = 0; i < 6; i += 1) writer.append("x".repeat(4000));
    await waitFor(() => !writer.connected, "the writer to be disconnected");
    expect(server.logs.find("byte budget exceeded; disconnecting")).toHaveLength(1);
    await settle(200);
    expect(other.connected).toBe(true);
    // Whatever fitted in the budget is stored; the rest never reached the log.
    expect((await updateRows(f.documentId)).length).toBeLessThan(6);
  });

  it("refuses writes past the document's size cap and keeps serving reads", async () => {
    const server = await launch({ limits: { maxDocumentBytes: 5000 } });
    const f = await createDocument();
    const writer = await TestClient.connect(server, f, "owner", "owner");
    const reader = await TestClient.connect(server, f, "viewer", "viewer");
    for (let i = 0; i < 3; i += 1) writer.append("y".repeat(1500));
    await waitFor(() => reader.text.length === 4500, "three chunks to arrive");
    await waitFor(async () => (await updateRows(f.documentId)).length === 3, "three log rows");

    writer.append("z".repeat(1500));
    await waitFor(() => writer.rejected.length === 1, "a rejection");
    expect(writer.rejected[0]).toEqual({ event: "sync", reason: "document_full" });
    await settle(200);
    expect(reader.text).toHaveLength(4500);
    const stored = (await updateRows(f.documentId)).reduce((n, r) => n + r.data.length, 0);
    expect(stored).toBeLessThanOrEqual(5000);
    expect(writer.connected).toBe(true);

    // A newcomer still reads the document.
    const late = await TestClient.connect(server, f, "editor", "editor");
    expect(late.text).toHaveLength(4500);
  });

  it("bounds the queue of updates waiting for a slow database", async () => {
    const server = await launch({ limits: { maxUpdateBytes: 2000, maxPendingBytes: 4000 } });
    const f = await createDocument();
    const writer = await TestClient.connect(server, f, "owner", "owner");
    const other = await TestClient.connect(server, f, "editor", "editor");
    const { release } = holdAppends(server);
    for (let i = 0; i < 3; i += 1) {
      writer.append("q".repeat(1500));
      await settle(60);
    }
    await waitFor(() => !writer.connected, "the writer to be disconnected");
    expect(writer.rejected).toContainEqual({ event: "sync", reason: "overloaded" });
    expect(server.logs.find("update queue is full; disconnecting")).toHaveLength(1);
    release();
    await waitFor(async () => (await updateRows(f.documentId)).length === 2, "the queued rows");
    await settle(200);
    // The update that did not fit was never applied, so the other client never saw it.
    expect(other.text).toHaveLength(3000);
    expect(await updateRows(f.documentId)).toHaveLength(2);
  });
});

describe("the connection limit under concurrent handshakes", () => {
  async function stampede(
    servers: Awaited<ReturnType<typeof launch>>[],
    count: number,
  ): Promise<{ connected: number; refused: number }> {
    const f = await createDocument();
    const clients = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        TestClient.connect(servers[i % servers.length]!, f, "owner", "owner", { noWait: true }),
      ),
    );
    await settle(1500);
    return {
      connected: clients.filter((c) => c.connected).length,
      refused: clients.filter((c) => c.connectErrors[0]?.code === "too_many_connections").length,
    };
  }

  it("admits exactly the limit when many sockets arrive at once on one instance", async () => {
    const server = await launch({ limits: { maxConnectionsPerDocument: 3 } });
    expect(await stampede([server], 12)).toEqual({ connected: 3, refused: 9 });
  });

  it("admits exactly the limit when many sockets arrive at once on two instances", async () => {
    const a = await launch({
      redis: true,
      instanceId: "A",
      limits: { maxConnectionsPerDocument: 3 },
    });
    const b = await launch({
      redis: true,
      instanceId: "B",
      limits: { maxConnectionsPerDocument: 3 },
    });
    expect(await stampede([a, b], 12)).toEqual({ connected: 3, refused: 9 });
  });

  it("counts sockets that other instances hold, and forgets the ones that expired", async () => {
    const server = await launch({ redis: true, limits: { maxConnectionsPerDocument: 1 } });
    const f = await createDocument();
    const redis = redisClient();
    const key = `${adapterKey()}:conn:${f.documentId}`;
    // A socket on another instance, alive for another minute.
    await redis.zadd(key, Date.now() + 60_000, "remote-socket");
    expect((await connectErrorOf(server, f, "owner", "owner")).code).toBe("too_many_connections");
    // The same entry, after its instance died and the expiry passed.
    await redis.zadd(key, Date.now() - 1000, "remote-socket");
    const client = await TestClient.connect(server, f, "owner", "owner");
    expect(client.connected).toBe(true);
  });

  it("frees the slot when the socket goes away, also in Redis mode", async () => {
    const server = await launch({ redis: true, limits: { maxConnectionsPerDocument: 1 } });
    const f = await createDocument();
    const first = await TestClient.connect(server, f, "owner", "owner");
    expect((await connectErrorOf(server, f, "editor", "editor")).code).toBe("too_many_connections");
    first.close();
    await settle(300);
    const second = await TestClient.connect(server, f, "editor", "editor");
    expect(second.connected).toBe(true);
  });
});
