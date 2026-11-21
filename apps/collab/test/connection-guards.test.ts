import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { io as connect } from "socket.io-client";
import {
  TestClient,
  cleanup,
  closeDb,
  createDocument,
  launch,
  mintToken,
  resetDb,
  waitFor,
} from "./support";

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
