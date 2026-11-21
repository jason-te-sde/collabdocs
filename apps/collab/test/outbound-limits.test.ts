import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_LIMITS } from "../src/config";
import { bufferedBytes } from "../src/outbound";
import {
  TestClient,
  cleanup,
  closeDb,
  createDocument,
  launch,
  resetDb,
  settle,
  snapshotRows,
  storedText,
  updateRows,
  waitFor,
} from "./support";

beforeEach(resetDb);
afterEach(cleanup);
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
 * Queues 20 MB for a socket whose client has stopped reading. One message larger than the
 * operating system's buffers: the WebSocket counts a write that has not finished in full, so
 * the queue the server acts on is the real one, not a stand-in.
 */
function stuff(serverSide: ReturnType<typeof serverSideOf>): void {
  serverSide.emit("sync", new Uint8Array(20_000_000));
  expect(bufferedBytes(serverSide)).toBeGreaterThan(DEFAULT_LIMITS.maxOutboundBytes);
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
    // A broadcast closes a socket at once past the cap plus a whole document (here 1.1 MB).
    const server = await launch({
      limits: { maxOutboundBytes: 100_000, maxDocumentBytes: 1_000_000 },
    });
    const f = await createDocument();
    const owner = await TestClient.connect(server, f, "owner", "owner");
    const editor = await TestClient.connect(server, f, "editor", "editor");
    const viewer = await TestClient.connect(server, f, "viewer", "viewer");
    stopReading(viewer);
    const serverSide = serverSideOf(server, f.users.viewer!);
    stuff(serverSide);

    owner.append("written while the viewer is stalled");
    await waitFor(() => !serverSide.connected, "the stalled viewer to be disconnected", 2000);
    expect(server.logs.find("outbound queue over the cap; disconnecting")).toEqual([
      expect.objectContaining({ userId: f.users.viewer }),
    ]);
    expect(
      server.logs.find("outbound queue over the cap and not draining; closing the connection"),
    ).toEqual([]);
    // Everyone else is untouched and still receives.
    await waitFor(() => editor.text === "written while the viewer is stalled", "the editor's copy");
    owner.append("!");
    await waitFor(() => editor.text.endsWith("!"), "a second broadcast to the editor");
    expect(owner.connected).toBe(true);
    expect(editor.connected).toBe(true);
  });

  it("does not close a socket that is over the cap by less than a document while it is draining", async () => {
    // Over the cap (100 KB) but under the cap plus a document: a broadcast leaves it alone.
    const server = await launch({ limits: { maxOutboundBytes: 100_000 } });
    const f = await createDocument();
    const owner = await TestClient.connect(server, f, "owner", "owner");
    const viewer = await TestClient.connect(server, f, "viewer", "viewer");
    const serverSide = serverSideOf(server, f.users.viewer!);
    const transport = (serverSide.conn as unknown as { transport: { socket: object } }).transport;
    Object.defineProperty(transport.socket, "bufferedAmount", { get: () => 5_000_000 });
    owner.append("still fine");
    await waitFor(() => viewer.text === "still fine", "the viewer to receive");
    expect(serverSide.connected).toBe(true);
    expect(server.logs.find("outbound queue over the cap; disconnecting")).toEqual([]);
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
  it("closes a connection that has stopped reading on a document nothing is written to", async () => {
    const server = await launch();
    const f = await createDocument();
    const viewer = await TestClient.connect(server, f, "viewer", "viewer");
    stopReading(viewer);
    const serverSide = serverSideOf(server, f.users.viewer!);
    // Nothing is broadcast and the client asks for nothing, so no check on the document's
    // path runs: only the sweep can find it, at its second look at a queue that has not shrunk.
    stuff(serverSide);

    await waitFor(() => !serverSide.connected, "the sweep to close the connection", 7000);
    expect(
      server.logs.find("outbound queue over the cap and not draining; closing the connection"),
    ).toHaveLength(1);
    expect(server.logs.find("outbound queue over the cap; disconnecting")).toEqual([]);
    expect(serverSide.conn.readyState).toBe("closed");
  });

  it("refuses a document-sized reply to a socket that has not taken what it was sent", async () => {
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
    const viewer = await TestClient.connect(server, f, "viewer", "viewer");
    stopReading(viewer);
    const serverSide = serverSideOf(server, f.users.viewer!);
    // Same tick: the sweep needs two looks, so only the reply's own check can win this.
    stuff(serverSide);
    viewer.socket.emit("sync", Uint8Array.from([0, 1, 0]));

    await waitFor(() => !serverSide.connected, "the reply path to disconnect the viewer", 3000);
    expect(server.logs.find("outbound queue over the cap; disconnecting")).toHaveLength(1);
    expect(server.logs.find("byte budget exceeded by replies; disconnecting")).toEqual([]);
    expect(
      server.logs.find("outbound queue over the cap and not draining; closing the connection"),
    ).toEqual([]);
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
    // The byte cap is out of the way: this is about what a broadcast does with a long queue.
    const server = await launch({ limits: { maxOutboundBytes: 1_000_000_000 } });
    const f = await createDocument();
    const owner = await TestClient.connect(server, f, "owner", "owner");
    const viewer = await TestClient.connect(server, f, "viewer", "viewer");
    stopReading(viewer);
    const serverSide = serverSideOf(server, f.users.viewer!);
    // The stuffed message holds the transport (Socket.IO sends its header first and the
    // attachment after), so what follows waits in Engine.IO's buffer.
    stuff(serverSide);
    const engine = serverSide.conn as unknown as { writeBuffer: unknown[] };
    await waitFor(() => engine.writeBuffer.length === 0, "the stuffed message to reach the socket");

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
