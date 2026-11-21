import type { Role } from "@collabdocs/shared";
import { io as connect, type Socket } from "socket.io-client";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../src/config";
import { bufferedBytes } from "../src/outbound";
import {
  TestClient,
  cleanup,
  closeDb,
  createDocument,
  launch,
  mintToken,
  resetDb,
  settle,
  snapshotRows,
  storedText,
  updateRows,
  waitFor,
  type Fixture,
} from "./support";

const stalledClients: Socket[] = [];

beforeEach(resetDb);
afterEach(cleanup);
afterEach(() => {
  for (const socket of stalledClients.splice(0)) socket.close();
});
afterAll(closeDb);

/** Stops the client's TCP socket from reading: what the server sends to it stays queued. */
function stopReading(client: TestClient): void {
  const engine = client.socket.io.engine as unknown as {
    transport: { ws: { _socket: { pause(): void } } };
  };
  engine.transport.ws._socket.pause();
}

type Launched = Awaited<ReturnType<typeof launch>>;

/** The server's side of a connected user's socket. */
function serverSideOf(server: Launched, userId: string) {
  const socket = [...server.io.of("/").sockets.values()].find((s) => s.data.userId === userId);
  if (!socket) throw new Error(`no server-side socket for ${userId}`);
  return socket;
}

/**
 * A member whose client connects over long polling and then never polls again. Nothing is
 * in the operating system's buffers for such a client: every packet the server has for it
 * stays in Engine.IO's write buffer, so the queue the server acts on is a real one.
 */
async function connectStalled(
  server: Launched,
  fixture: Fixture,
  who: string,
  role: Role,
): Promise<Socket> {
  const token = await mintToken(fixture.documentId, fixture.users[who]!, role, { name: who });
  const socket = connect(`http://127.0.0.1:${server.port}`, {
    auth: { token, documentId: fixture.documentId },
    transports: ["polling"],
    upgrade: false,
    reconnection: false,
    forceNew: true,
  });
  stalledClients.push(socket);
  let stalled = false;
  await new Promise<void>((resolve, reject) => {
    socket.on("connect", () => {
      (socket.io.engine as unknown as { transport: { doPoll: () => void } }).transport.doPoll =
        () => {
          stalled = true;
        };
      resolve();
    });
    socket.on("connect_error", reject);
  });
  // A poll may already be waiting at the server. One packet answers it; the client then asks
  // for the next poll, which it does not make. From then on nothing is taken from the server.
  serverSideOf(server, fixture.users[who]!).emit("sync", new Uint8Array(1));
  await waitFor(() => stalled, "the client to stop polling");
  return socket;
}

/** A document of `size` bytes of text, written by its owner and stored. */
async function documentOf(server: Launched, size: number) {
  const f = await createDocument();
  const owner = await TestClient.connect(server, f, "owner", "owner");
  for (let written = 0; written < size; written += 40_000) {
    owner.append("x".repeat(40_000));
    // Let the socket's budget refill, in tests that give it a small burst.
    await settle(25);
  }
  await waitFor(
    async () => (await server.store.storedBytes(f.documentId)) >= size - 5_000,
    "the content to be stored",
  );
  return { f, owner };
}

/** Records the most bytes ever queued for a socket, sampled every 10 ms. */
function watchQueue(socket: ReturnType<typeof serverSideOf>) {
  let max = 0;
  const timer = setInterval(() => {
    max = Math.max(max, bufferedBytes(socket));
  }, 10);
  return {
    stop: () => {
      clearInterval(timer);
      return max;
    },
  };
}

describe("what the server queues for a socket is bounded", () => {
  it("disconnects a viewer that stops reading and asks for the document again and again", async () => {
    const server = await launch();
    const f = await createDocument();
    const owner = await TestClient.connect(server, f, "owner", "owner");
    owner.append("x".repeat(200_000));
    await waitFor(
      async () => (await server.store.storedBytes(f.documentId)) > 190_000,
      "the content to be stored",
    );
    const viewer = await TestClient.connect(server, f, "viewer", "viewer");
    stopReading(viewer);
    const serverSide = serverSideOf(server, f.users.viewer!);
    const watch = watchQueue(serverSide);

    // Each sync step 1 is three bytes from the client and a copy of the document from the server.
    const stepOne = Uint8Array.from([0, 1, 0]);
    for (let i = 0; i < 150; i += 1) viewer.socket.emit("sync", stepOne);

    await waitFor(() => !serverSide.connected, "the server to disconnect the viewer", 2000);
    const mostQueued = watch.stop();
    // The cap, plus the one reply that was queued before the check that stopped the next.
    expect(mostQueued).toBeLessThanOrEqual(DEFAULT_LIMITS.maxOutboundBytes + 400_000);
    // And what was queued is freed at once, not at the ping timeout.
    await waitFor(
      () => serverSide.conn.readyState === "closed",
      "the connection to be closed, not left to the ping timeout",
      1000,
    );
    expect((serverSide.conn as unknown as { writeBuffer: unknown[] }).writeBuffer).toEqual([]);
    expect(server.logs.find("byte budget exceeded by replies; disconnecting")).toHaveLength(1);
    expect(owner.connected).toBe(true);
  });

  it("charges the replies to the user's budget as well as the socket's", async () => {
    // The socket budget is large; only the user's budget (shared by the user's sockets) is small.
    const server = await launch({
      limits: {
        byteBurst: 8_000_000,
        maxBytesPerSecondPerUser: 1_000,
        byteBurstPerUser: 1_100_000,
      },
    });
    const f = await createDocument();
    const owner = await TestClient.connect(server, f, "owner", "owner");
    owner.append("x".repeat(500_000));
    await waitFor(
      async () => (await server.store.storedBytes(f.documentId)) > 490_000,
      "the content to be stored",
    );
    const stepOne = Uint8Array.from([0, 1, 0]);
    const first = await TestClient.connect(server, f, "viewer", "viewer");
    const second = await TestClient.connect(server, f, "viewer", "viewer");
    // Each connection already took one reply (about 500 KB). Two more cannot fit in 1.1 MB.
    first.socket.emit("sync", stepOne);
    await waitFor(() => !first.connected, "the reply to be refused for the user's budget", 3000);
    expect(server.logs.find("byte budget exceeded by replies; disconnecting")).toHaveLength(1);
    // The socket's own budget was nowhere near spent: only the user's is.
    expect(second.connected).toBe(true);
  });

  it("disconnects a socket that is not taking broadcasts while another member writes", async () => {
    const server = await launch({ limits: { maxOutboundBytes: 300_000 } });
    const f = await createDocument();
    const owner = await TestClient.connect(server, f, "owner", "owner");
    const editor = await TestClient.connect(server, f, "editor", "editor");
    const viewer = await TestClient.connect(server, f, "viewer", "viewer");
    stopReading(viewer);
    const serverSide = serverSideOf(server, f.users.viewer!);
    // A kernel send buffer large enough to swallow a test's traffic would hide the problem on
    // some machines, so the transport is made to report what a stalled client leaves behind:
    // ten megabytes accepted by the WebSocket and not handed to the operating system.
    const transport = (serverSide.conn as unknown as { transport: { socket: object } }).transport;
    Object.defineProperty(transport.socket, "bufferedAmount", { get: () => 10_000_000 });
    expect(bufferedBytes(serverSide)).toBeGreaterThanOrEqual(10_000_000);

    owner.append("written while the viewer is stalled");
    await waitFor(() => !serverSide.connected, "the stalled viewer to be disconnected", 2000);
    expect(server.logs.find("outbound queue over the cap; disconnecting")).toEqual([
      expect.objectContaining({ userId: f.users.viewer }),
    ]);
    // Everyone else is untouched and still receives.
    await waitFor(() => editor.text === "written while the viewer is stalled", "the editor's copy");
    owner.append("!");
    await waitFor(() => editor.text.endsWith("!"), "a second broadcast to the editor");
    expect(owner.connected).toBe(true);
    expect(editor.connected).toBe(true);
  });

  it("does not disconnect a socket whose queue is under the cap", async () => {
    const server = await launch({ limits: { maxOutboundBytes: 300_000 } });
    const f = await createDocument();
    const owner = await TestClient.connect(server, f, "owner", "owner");
    const viewer = await TestClient.connect(server, f, "viewer", "viewer");
    const serverSide = serverSideOf(server, f.users.viewer!);
    const transport = (serverSide.conn as unknown as { transport: { socket: object } }).transport;
    Object.defineProperty(transport.socket, "bufferedAmount", { get: () => 299_000 });
    owner.append("still fine");
    await waitFor(() => viewer.text === "still fine", "the viewer to receive");
    expect(serverSide.connected).toBe(true);
    expect(server.logs.find("outbound queue over the cap; disconnecting")).toEqual([]);
  });
});

describe("what the server queues is measured and bounded on real queues", () => {
  it("disconnects a client that does not poll while another member writes", async () => {
    const server = await launch({ limits: { maxOutboundBytes: 100_000 } });
    const f = await createDocument();
    const owner = await TestClient.connect(server, f, "owner", "owner");
    await connectStalled(server, f, "viewer", "viewer");
    const serverSide = serverSideOf(server, f.users.viewer!);

    for (let i = 0; i < 6; i += 1) owner.append("y".repeat(30_000));
    await waitFor(() => !serverSide.connected, "the stalled viewer to be disconnected", 3000);
    expect(server.logs.find("outbound queue over the cap; disconnecting")).toEqual([
      expect.objectContaining({ userId: f.users.viewer, queuedBytes: expect.any(Number) }),
    ]);
    expect(
      (server.logs.find("outbound queue over the cap; disconnecting")[0]!.queuedBytes as number) >
        100_000,
    ).toBe(true);
    expect(owner.connected).toBe(true);
  });

  it("disconnects a client that is not reading on a document nothing is written to", async () => {
    const server = await launch();
    const f = await createDocument();
    await connectStalled(server, f, "viewer", "viewer");
    const serverSide = serverSideOf(server, f.users.viewer!);
    // Nothing is broadcast and the client asks for nothing, so no check on the document's
    // path runs. Something else fills the queue (a real one: the polling client takes nothing).
    for (let i = 0; i < 60; i += 1) serverSide.emit("sync", new Uint8Array(100_000));
    expect(bufferedBytes(serverSide)).toBeGreaterThan(DEFAULT_LIMITS.maxOutboundBytes);

    await waitFor(() => !serverSide.connected, "the sweep to close the connection", 2000);
    expect(server.logs.find("outbound queue over the cap; closing the connection")).toHaveLength(1);
    expect(server.logs.find("outbound queue over the cap; disconnecting")).toEqual([]);
    expect(serverSide.conn.readyState).toBe("closed");
  });

  it("refuses a second document-sized reply to a socket that has not taken the first", async () => {
    // The document (300 KB) is larger than the socket's burst (50 KB), so a reply is charged
    // half a bucket and the budgets are never what stops it: only the queue check in the reply can.
    const server = await launch({
      limits: {
        maxUpdateBytes: 50_000,
        byteBurst: 50_000,
        byteBurstPerUser: 1_000_000,
        maxBytesPerSecond: 1_000_000_000,
        maxBytesPerSecondPerUser: 1_000_000_000,
        maxOutboundBytes: 150_000,
      },
    });
    const { f } = await documentOf(server, 300_000);
    const viewer = await connectStalled(server, f, "viewer", "viewer");
    const serverSide = serverSideOf(server, f.users.viewer!);

    const stepOne = Uint8Array.from([0, 1, 0]);
    // Spaced out: the budgets refill by the millisecond, and a bucket that a reply emptied
    // must be full again for the next one, so that only the queue can refuse it.
    for (let i = 0; i < 4; i += 1) {
      viewer.emit("sync", stepOne);
      await settle(25);
    }
    await waitFor(() => !serverSide.connected, "the reply path to disconnect the viewer", 3000);
    expect(server.logs.find("outbound queue over the cap; disconnecting")).toHaveLength(1);
    expect(server.logs.find("byte budget exceeded by replies; disconnecting")).toEqual([]);
  });

  it("charges a reply to the socket's own budget, though the user's budget is large", async () => {
    // Without a refill, the socket's bucket holds one reply (half its burst, 150 KB) and what
    // is left after the messages the client sent is a little short of a second one.
    const server = await launch({
      limits: { maxUpdateBytes: 100_000, byteBurst: 300_000, maxBytesPerSecond: 1 },
    });
    const { f } = await documentOf(server, 200_000);
    const viewer = await TestClient.connect(server, f, "viewer", "viewer");
    // The reply to the connect took 150 KB of 300 KB. A second one does not fit.
    viewer.socket.emit("sync", Uint8Array.from([0, 1, 0]));
    await waitFor(() => !viewer.connected, "the socket's budget to refuse the reply", 3000);
    expect(server.logs.find("byte budget exceeded by replies; disconnecting")).toHaveLength(1);
  });

  it("checks a socket's queue without reading the packets in it, however many there are", async () => {
    const server = await launch();
    const f = await createDocument();
    const owner = await TestClient.connect(server, f, "owner", "owner");
    await connectStalled(server, f, "viewer", "viewer");
    const serverSide = serverSideOf(server, f.users.viewer!);

    // Every way of reading the write buffer packet by packet is counted; its length is not.
    let packetReads = 0;
    const conn = serverSide.conn as unknown as { writeBuffer: unknown[] };
    let real = conn.writeBuffer;
    Object.defineProperty(conn, "writeBuffer", {
      get: () =>
        new Proxy(real, {
          get(target, key, receiver) {
            if (typeof key === "symbol" || /^\d+$/.test(key)) packetReads += 1;
            return Reflect.get(target, key, receiver) as unknown;
          },
        }),
      set: (value: unknown[]) => {
        real = value;
      },
    });

    for (let i = 0; i < 3_000; i += 1) serverSide.emit("sync", Uint8Array.from([0, 1, 0]));
    const queuedBefore = real.length;
    expect(queuedBefore).toBeGreaterThan(5_000);
    for (let i = 0; i < 20; i += 1) owner.append("z");
    // Twenty broadcasts reach the socket, and none reads the packets queued for it.
    await waitFor(() => real.length >= queuedBefore + 20, "the broadcasts to be queued");
    expect(packetReads).toBe(0);
    expect(serverSide.connected).toBe(true);
  });
});

describe("shutdown", () => {
  it(
    "finishes the documents (final compaction) without waiting for a client that does not read",
    { timeout: 15_000 },
    async () => {
      const server = await launch();
      const f = await createDocument();
      const owner = await TestClient.connect(server, f, "owner", "owner");
      const viewer = await TestClient.connect(server, f, "viewer", "viewer");
      stopReading(viewer);
      owner.append("typed before shutdown");
      await waitFor(async () => (await updateRows(f.documentId)).length === 1, "the log row");
      expect(await snapshotRows(f.documentId)).toHaveLength(0);

      const began = Date.now();
      const closing = server.close();
      // Closing the document folds the log into a snapshot. That happens while the sockets
      // close, so it is done well before the viewer's connection is cut (a second after the
      // shutdown began), not after the transport is gone: a bound of 900 ms.
      await waitFor(
        async () => (await snapshotRows(f.documentId)).length === 1,
        "the document to be compacted while the viewer is still connected",
        900,
      );
      await closing;
      expect(Date.now() - began).toBeLessThan(8000);
      expect(await storedText(f.documentId)).toBe("typed before shutdown");
    },
  );
});
