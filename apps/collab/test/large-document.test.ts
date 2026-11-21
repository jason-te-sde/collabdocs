import * as Y from "yjs";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { TestClient, cleanup, closeDb, createDocument, launch, resetDb, waitFor } from "./support";
import { engineConnections } from "../src/outbound";

beforeEach(resetDb);
afterEach(cleanup);
afterAll(closeDb);

const DOCUMENT_BYTES = 14_000_000;

type Launched = Awaited<ReturnType<typeof launch>>;

/** Puts a document of about `size` bytes in the database, as if it had been written long ago. */
async function storeDocument(server: Launched, documentId: string, size: number): Promise<void> {
  const doc = new Y.Doc();
  doc.getText("text").insert(0, "x".repeat(size));
  await server.store.append(documentId, [Y.encodeStateAsUpdate(doc)]);
}

interface PausableSocket {
  pause(): void;
  read(): unknown;
  bytesRead: number;
}

/** The client's TCP socket, from the WebSocket transport of its Socket.IO connection. */
async function tcpSocketOf(client: TestClient): Promise<PausableSocket> {
  const engine = () =>
    client.socket.io.engine as unknown as { transport?: { ws?: { _socket?: PausableSocket } } };
  await waitFor(() => engine()?.transport?.ws?._socket != null, "the connection to open");
  return engine().transport!.ws!._socket!;
}

describe("a document as large as the document cap", () => {
  it(
    "opens for a client that reads at a steady few MB/s and announces presence, without a close",
    { timeout: 120_000 },
    async () => {
      const server = await launch();
      const f = await createDocument();
      await storeDocument(server, f.documentId, DOCUMENT_BYTES);

      const client = await TestClient.connect(server, f, "viewer", "viewer", { noWait: true });
      const tcp = await tcpSocketOf(client);
      // Up to 64 KB every 20 ms: about 3 MB/s, a 25 Mbit/s link. The download takes
      // several seconds, many sweeps, and the queue shrinks all the time.
      tcp.pause();
      const reader = setInterval(() => tcp.read(), 20);
      let moves = 0;
      const presence = setInterval(() => {
        if (client.connected) client.awareness.setLocalState(client.state({ move: (moves += 1) }));
      }, 100);
      // What the server sees of this connection, for the failure message.
      const seen: string[] = [];
      const watch = setInterval(() => {
        const conn = engineConnections(server.io.engine)[0] as {
          transport?: {
            socket?: {
              bufferedAmount?: number;
              _socket?: { _handle?: { writeQueueSize?: number } };
            };
          };
        };
        const ws = conn?.transport?.socket;
        seen.push(`${ws?.bufferedAmount}/${ws?._socket?._handle?.writeQueueSize}/${tcp.bytesRead}`);
      }, 500);
      try {
        await waitFor(() => client.synced, "the whole document to arrive", 45_000);
      } catch (error) {
        throw new Error(
          `${(error as Error).message}; connected ${client.connected}, disconnects ${client.disconnects}, ` +
            `buffered/pending/read per 500 ms: ${seen.join(" ")}; ` +
            JSON.stringify(server.logs.records.filter((r) => r.level !== "info")),
        );
      } finally {
        clearInterval(reader);
        clearInterval(presence);
        clearInterval(watch);
      }
      expect(client.text.length).toBe(DOCUMENT_BYTES);
      expect(client.connected).toBe(true);
      expect(client.disconnects).toBe(0);
      expect(server.logs.find("outbound queue over the cap; disconnecting")).toEqual([]);
      expect(
        server.logs.find("outbound queue over the cap and not draining; closing the connection"),
      ).toEqual([]);
    },
  );

  it("is not kept open for a client that stops reading: it is closed within four seconds", async () => {
    const server = await launch();
    const f = await createDocument();
    await storeDocument(server, f.documentId, DOCUMENT_BYTES);

    const began = Date.now();
    const client = await TestClient.connect(server, f, "viewer", "viewer", { noWait: true });
    const tcp = await tcpSocketOf(client);
    tcp.pause();
    // The client announces presence as the editor does. It never reads again, so it cannot
    // see the close: the server's log is what shows it.
    await waitFor(() => client.connected, "the socket to connect");
    client.awareness.setLocalState(client.state());
    const closes = () =>
      server.logs.find("outbound queue over the cap and not draining; closing the connection");
    await waitFor(() => closes().length > 0, "the server to close the stalled connection", 4000);
    expect(Date.now() - began).toBeLessThan(4000);
    expect(closes()).toHaveLength(1);
    expect(server.logs.find("outbound queue over the cap; disconnecting")).toEqual([]);
  });
});
