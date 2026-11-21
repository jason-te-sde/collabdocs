import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { Manager, io as connect } from "socket.io-client";
import {
  TestClient,
  cleanup,
  closeDb,
  createDocument,
  connectErrorOf,
  launch,
  mintToken,
  resetDb,
  waitFor,
} from "./support";
import { engineConnections } from "../src/outbound";

beforeEach(resetDb);
afterEach(cleanup);
afterAll(closeDb);

/** Opens a socket the way a browser on `origin` would (no origin: a client that is not a browser). */
async function open(
  port: number,
  documentId: string,
  token: string,
  options: { origin?: string; transport?: "websocket" | "polling" } = {},
): Promise<"connected" | "refused"> {
  const socket = connect(`http://127.0.0.1:${port}`, {
    auth: { token, documentId },
    transports: [options.transport ?? "websocket"],
    reconnection: false,
    forceNew: true,
    ...(options.origin ? { extraHeaders: { Origin: options.origin } } : {}),
  });
  try {
    return await new Promise((resolve) => {
      socket.on("connect", () => resolve("connected"));
      socket.on("connect_error", () => resolve("refused"));
    });
  } finally {
    socket.close();
  }
}

describe("COLLAB_CORS_ORIGIN is enforced on the WebSocket upgrade too", () => {
  it("refuses a browser on another origin, and lets the configured origin and non-browsers in", async () => {
    const server = await launch({ corsOrigin: ["http://localhost:3000", "https://docs.example"] });
    const f = await createDocument();
    const token = await mintToken(f.documentId, f.users.editor!, "editor");
    expect(await open(server.port, f.documentId, token, { origin: "https://evil.example" })).toBe(
      "refused",
    );
    expect(await open(server.port, f.documentId, token, { origin: "null" })).toBe("refused");
    expect(await open(server.port, f.documentId, token, { origin: "http://localhost:3000" })).toBe(
      "connected",
    );
    expect(await open(server.port, f.documentId, token, { origin: "https://docs.example" })).toBe(
      "connected",
    );
    expect(await open(server.port, f.documentId, token)).toBe("connected");
    expect(server.logs.find("connection refused: origin not allowed")).toEqual([
      expect.objectContaining({ origin: "https://evil.example" }),
      expect.objectContaining({ origin: "null" }),
    ]);
  });

  it("refuses a polling request from another origin as well", async () => {
    const server = await launch({ corsOrigin: "http://localhost:3000" });
    const f = await createDocument();
    const token = await mintToken(f.documentId, f.users.editor!, "editor");
    expect(
      await open(server.port, f.documentId, token, {
        origin: "https://evil.example",
        transport: "polling",
      }),
    ).toBe("refused");
  });

  it("with no origin configured, allows only the server's own origin", async () => {
    const server = await launch();
    const f = await createDocument();
    const token = await mintToken(f.documentId, f.users.editor!, "editor");
    expect(await open(server.port, f.documentId, token, { origin: "http://localhost:3000" })).toBe(
      "refused",
    );
    expect(
      await open(server.port, f.documentId, token, { origin: `http://127.0.0.1:${server.port}` }),
    ).toBe("connected");
    expect(await open(server.port, f.documentId, token)).toBe("connected");
  });
});

describe("events other than sync and awareness", () => {
  it("disconnects a socket that sends an event the server does not know", async () => {
    const server = await launch();
    const f = await createDocument();
    const viewer = await TestClient.connect(server, f, "viewer", "viewer");
    const big = new Uint8Array(500_000);
    for (let i = 0; i < 50; i += 1) viewer.socket.emit("zzz", big);
    await waitFor(() => !viewer.connected, "the server to disconnect the socket", 2000);
    expect(server.logs.find("unknown event; disconnecting")).toEqual([
      expect.objectContaining({ event: "zzz", userId: f.users.viewer }),
    ]);
  });

  it("leaves a socket that sends only sync and awareness alone", async () => {
    const server = await launch();
    const f = await createDocument();
    const owner = await TestClient.connect(server, f, "owner", "owner");
    const editor = await TestClient.connect(server, f, "editor", "editor");
    owner.awareness.setLocalState(owner.state());
    owner.append("known events only");
    await waitFor(() => editor.text === "known events only", "the edit to arrive");
    expect(owner.connected).toBe(true);
    expect(server.logs.find("unknown event; disconnecting")).toEqual([]);
  });
});

/** The Engine.IO side of a client, before anything has been said to Socket.IO. */
interface RawEngine {
  send(data: string): void;
  _sendPacket(type: string): void;
  transport: { ws?: { _socket: { pause(): void } }; doPoll?: () => void };
}

/** Opens an Engine.IO connection and nothing else: no namespace, no token. */
async function rawConnection(
  port: number,
  transport: "websocket" | "polling" = "websocket",
): Promise<{ engine: RawEngine; close(): void }> {
  const manager = new Manager(`http://127.0.0.1:${port}`, {
    transports: [transport],
    upgrade: false,
    reconnection: false,
    autoConnect: false,
    forceNew: true,
  });
  await new Promise<void>((resolve, reject) =>
    manager.open((error) => (error ? reject(error) : resolve())),
  );
  const engine = manager.engine as unknown as RawEngine;
  return { engine, close: () => manager.engine.close() };
}

/** The client stops reading: whatever the server sends it stays queued on the server's side. */
function stopReading(engine: RawEngine): void {
  engine.transport.ws!._socket.pause();
}

describe("connections that belong to no document", () => {
  const open = (server: Awaited<ReturnType<typeof launch>>) => server.io.engine.clientsCount;

  it("closes a connection that asks for a namespace the server does not have", async () => {
    const server = await launch();
    const raw = await rawConnection(server.port);
    stopReading(raw.engine);
    await waitFor(() => open(server) === 1, "the connection to be registered");
    // One packet is enough: a connection has no reason to ask for anything but "/".
    raw.engine.send("0/x,");
    await waitFor(() => open(server) === 0, "the server to close the connection", 2000);
    expect(server.logs.find("connect to a namespace the server does not have; closing it")).toEqual(
      [expect.objectContaining({ namespace: "/x" })],
    );
    raw.close();
  });

  it("closes a connection whose handshake was refused", async () => {
    const server = await launch();
    const raw = await rawConnection(server.port);
    stopReading(raw.engine);
    await waitFor(() => open(server) === 1, "the connection to be registered");
    // A CONNECT to "/" with no token: refused, and that is the end of the connection.
    raw.engine.send("0");
    await waitFor(() => open(server) === 0, "the server to close the connection", 2000);
    expect(server.logs.find("handshake refused")).toHaveLength(1);
    raw.close();
  });

  it("closes a connection that does not read and floods CONNECT packets, with or without a namespace", async () => {
    const server = await launch();
    const flood = async (packet: string) => {
      const raw = await rawConnection(server.port);
      stopReading(raw.engine);
      for (let i = 0; i < 5000; i += 1) raw.engine.send(packet);
      return raw;
    };
    const raws = [await flood("0/x,"), await flood("0")];
    await waitFor(() => open(server) === 0, "the server to close both connections", 2000);
    // Whatever was queued for them was freed: nothing is left in any write buffer.
    expect(engineConnections(server.io.engine)).toEqual([]);
    expect(server.logs.find("handshake refused").length).toBeLessThanOrEqual(1);
    for (const raw of raws) raw.close();
  });

  it("lets a client that reads see why its handshake was refused, then closes it", async () => {
    const server = await launch();
    const f = await createDocument();
    const error = await connectErrorOf(server, f, "viewer", "viewer", {
      token: "not a token",
    });
    expect(error.code).toBe("invalid_token");
    await waitFor(() => open(server) === 0, "the server to close the connection", 2000);
  });

  it("limits the warnings that refused handshakes write, whatever their number", async () => {
    const server = await launch();
    const began = Date.now();
    await Promise.all(
      Array.from({ length: 300 }, async () => {
        const raw = await rawConnection(server.port);
        raw.engine.send("0");
        return raw;
      }),
    );
    await waitFor(() => open(server) === 0, "every refused connection to be closed", 5000);
    const seconds = Math.ceil((Date.now() - began) / 1000);
    // A burst of 20 and 10 per second after it, however many connections there were.
    expect(server.logs.find("handshake refused").length).toBeLessThanOrEqual(20 + 10 * seconds + 1);
    expect(server.logs.find("handshake refused").length).toBeLessThan(300);
  });

  it("closes a connection that sends packets faster than its budget", async () => {
    const server = await launch({ limits: { packetBurst: 20, maxPacketsPerSecond: 1 } });
    const raw = await rawConnection(server.port);
    await waitFor(() => open(server) === 1, "the connection to be registered");
    for (let i = 0; i < 40; i += 1) raw.engine._sendPacket("pong");
    await waitFor(() => open(server) === 0, "the server to close the connection", 2000);
    expect(server.logs.find("too many packets from a connection; closing it")).toHaveLength(1);
    raw.close();
  });

  it("closes a connection that is over the queue cap and has joined nothing", async () => {
    const server = await launch();
    const raw = await rawConnection(server.port, "polling");
    await waitFor(() => open(server) === 1, "the connection to be registered");
    const conn = engineConnections(server.io.engine)[0] as { send(data: string): void };
    // From here the client sends no more poll requests: what the server queues stays queued.
    // A poll may be waiting at the server; one packet answers it, and the next poll is the
    // one that never happens.
    let stalled = false;
    raw.engine.transport.doPoll = () => {
      stalled = true;
    };
    conn.send("0");
    await waitFor(() => stalled, "the client to stop polling");
    for (let i = 0; i < 20_000; i += 1) conn.send("0");
    await waitFor(() => open(server) === 0, "the sweep to close the connection", 2000);
    expect(server.logs.find("outbound queue over the cap; closing the connection")).toEqual([
      expect.objectContaining({ queuedPackets: expect.any(Number) }),
    ]);
    raw.close();
  });
});
