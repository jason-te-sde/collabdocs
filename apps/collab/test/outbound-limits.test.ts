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
