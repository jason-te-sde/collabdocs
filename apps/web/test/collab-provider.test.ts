import * as decoding from "lib0/decoding";
import * as encoding from "lib0/encoding";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as awarenessProtocol from "y-protocols/awareness";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import {
  CollabAccessError,
  CollabProvider,
  type NetworkStatus,
  type SocketLike,
} from "@/lib/collab/provider";

class FakeSocket implements SocketLike {
  connected = false;
  auth: unknown = {};
  readonly emitted: Array<{ event: string; data: unknown }> = [];
  connectCalls = 0;
  disconnectCalls = 0;
  private readonly handlers = new Map<string, Array<(...args: unknown[]) => void>>();

  on(event: string, handler: (...args: never[]) => void): this {
    const list = this.handlers.get(event) ?? [];
    list.push(handler as (...args: unknown[]) => void);
    this.handlers.set(event, list);
    return this;
  }
  emit(event: string, data?: unknown): this {
    this.emitted.push({ event, data });
    return this;
  }
  connect(): this {
    this.connectCalls += 1;
    return this;
  }
  disconnect(): this {
    this.disconnectCalls += 1;
    if (this.connected) this.drop("io client disconnect");
    return this;
  }
  // -- test controls
  fire(event: string, ...args: unknown[]): void {
    for (const handler of this.handlers.get(event) ?? []) handler(...args);
  }
  accept(): void {
    this.connected = true;
    this.fire("connect");
  }
  drop(reason: string): void {
    this.connected = false;
    this.fire("disconnect", reason);
  }
  reject(code: string | undefined): void {
    this.fire("connect_error", Object.assign(new Error("denied"), code ? { data: { code } } : {}));
  }
  sent(event: string): Uint8Array[] {
    return this.emitted.filter((e) => e.event === event).map((e) => e.data as Uint8Array);
  }
}

class FakeNetwork implements NetworkStatus {
  online = true;
  private listeners = new Set<(online: boolean) => void>();
  isOnline(): boolean {
    return this.online;
  }
  subscribe(listener: (online: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  set(online: boolean): void {
    this.online = online;
    for (const listener of this.listeners) listener(online);
  }
}

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve();
};

function setup(role: "owner" | "editor" | "viewer" = "editor") {
  const doc = new Y.Doc();
  const socket = new FakeSocket();
  const network = new FakeNetwork();
  const fetchToken = vi.fn(async () => ({ token: `token-${fetchToken.mock.calls.length}`, role }));
  const provider = new CollabProvider({
    documentId: "doc-1",
    doc,
    url: "http://collab.test",
    fetchToken,
    createSocket: () => socket,
    network,
    random: () => 0.5,
  });
  return { doc, socket, network, fetchToken, provider };
}

function stepOneOf(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  syncProtocol.writeSyncStep1(encoder, doc);
  return encoding.toUint8Array(encoder);
}
function stepTwoOf(doc: Y.Doc): Uint8Array {
  const encoder = encoding.createEncoder();
  syncProtocol.writeSyncStep2(encoder, doc);
  return encoding.toUint8Array(encoder);
}
function messageType(message: Uint8Array): number {
  return decoding.readVarUint(decoding.createDecoder(message));
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("CollabProvider", () => {
  it("fetches a token, connects with it and sends sync step 1", async () => {
    const { socket, provider, fetchToken } = setup();
    provider.connect();
    expect(provider.getSnapshot().state).toBe("connecting");
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(1);
    expect(socket.auth).toEqual({ token: "token-1", documentId: "doc-1" });
    expect(socket.connectCalls).toBe(1);
    socket.accept();
    expect(provider.getSnapshot().state).toBe("connected");
    expect(provider.getSnapshot().role).toBe("editor");
    const first = socket.sent("sync")[0];
    expect(first && messageType(first)).toBe(syncProtocol.messageYjsSyncStep1);
  });

  it("is synced once the server's step 2 arrives, and applies it", async () => {
    const { doc, socket, provider } = setup();
    provider.connect();
    await flush();
    socket.accept();
    expect(provider.getSnapshot().synced).toBe(false);
    const server = new Y.Doc();
    server.getText("t").insert(0, "from the server");
    socket.fire("sync", stepTwoOf(server));
    expect(doc.getText("t").toString()).toBe("from the server");
    expect(provider.getSnapshot().synced).toBe(true);
  });

  it("answers the server's step 1 with a step 2 carrying local edits (an editor)", async () => {
    const { doc, socket, provider } = setup();
    doc.getText("t").insert(0, "typed offline");
    provider.connect();
    await flush();
    socket.accept();
    socket.emitted.length = 0;
    socket.fire("sync", stepOneOf(new Y.Doc()));
    const reply = socket.sent("sync")[0];
    expect(reply && messageType(reply)).toBe(syncProtocol.messageYjsSyncStep2);
    const peer = new Y.Doc();
    syncProtocol.readSyncMessage(
      decoding.createDecoder(reply!),
      encoding.createEncoder(),
      peer,
      "test",
    );
    expect(peer.getText("t").toString()).toBe("typed offline");
  });

  it("sends local edits as updates while connected, but not remote ones", async () => {
    const { doc, socket, provider } = setup();
    provider.connect();
    await flush();
    socket.accept();
    socket.emitted.length = 0;
    doc.getText("t").insert(0, "x");
    expect(socket.sent("sync").map(messageType)).toEqual([syncProtocol.messageYjsUpdate]);
    socket.emitted.length = 0;
    const server = new Y.Doc();
    server.getText("t").insert(0, "y");
    const encoder = encoding.createEncoder();
    syncProtocol.writeUpdate(encoder, Y.encodeStateAsUpdate(server));
    socket.fire("sync", encoding.toUint8Array(encoder));
    expect(socket.sent("sync")).toEqual([]);
  });

  describe("a viewer", () => {
    it("never sends an update, and never answers a step 1", async () => {
      const { doc, socket, provider } = setup("viewer");
      provider.connect();
      await flush();
      socket.accept();
      socket.emitted.length = 0;
      doc.getText("t").insert(0, "forced");
      socket.fire("sync", stepOneOf(new Y.Doc()));
      expect(socket.sent("sync")).toEqual([]);
      expect(provider.getSnapshot().readOnly).toBe(true);
    });

    it("still applies what the server sends and shows its cursor", async () => {
      const { doc, socket, provider } = setup("viewer");
      provider.connect();
      await flush();
      socket.accept();
      const server = new Y.Doc();
      server.getText("t").insert(0, "read me");
      socket.fire("sync", stepTwoOf(server));
      expect(doc.getText("t").toString()).toBe("read me");
      expect(provider.getSnapshot().synced).toBe(true);
      socket.emitted.length = 0;
      provider.awareness.setLocalStateField("user", { name: "v" });
      expect(socket.sent("awareness")).toHaveLength(1);
    });
  });

  it("refreshes the token on every reconnect", async () => {
    const { socket, provider, fetchToken } = setup();
    provider.connect();
    await flush();
    socket.accept();
    socket.drop("transport close");
    expect(provider.getSnapshot().state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(socket.auth).toEqual({ token: "token-2", documentId: "doc-1" });
    expect(socket.connectCalls).toBe(2);
  });

  it("backs off between failed attempts", async () => {
    const { socket, provider, fetchToken } = setup();
    provider.connect();
    await flush();
    socket.reject(undefined);
    // random() is 0.5, so a delay is 75% of the ceiling: 375 ms, then 750 ms.
    await vi.advanceTimersByTimeAsync(300);
    expect(fetchToken).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchToken).toHaveBeenCalledTimes(2);
    socket.reject(undefined);
    await vi.advanceTimersByTimeAsync(700);
    expect(fetchToken).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(fetchToken).toHaveBeenCalledTimes(3);
  });

  it("stops for good when the server says the user is not a member", async () => {
    const { socket, provider, fetchToken } = setup();
    provider.connect();
    await flush();
    socket.reject("not_a_member");
    expect(provider.getSnapshot().state).toBe("denied");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });

  it("is denied when the token endpoint answers 404 or 403, and retries on other failures", async () => {
    const { provider, fetchToken, socket } = setup();
    fetchToken.mockRejectedValueOnce(new CollabAccessError(404));
    provider.connect();
    await flush();
    expect(provider.getSnapshot()).toMatchObject({ state: "denied", deniedReason: "no-access" });
    expect(socket.connectCalls).toBe(0);

    const second = setup();
    second.fetchToken.mockRejectedValueOnce(new Error("network down"));
    second.provider.connect();
    await flush();
    expect(second.provider.getSnapshot().state).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(2000);
    expect(second.fetchToken).toHaveBeenCalledTimes(2);

    const third = setup();
    third.fetchToken.mockRejectedValueOnce(new CollabAccessError(401));
    third.provider.connect();
    await flush();
    expect(third.provider.getSnapshot()).toMatchObject({
      state: "denied",
      deniedReason: "signed-out",
    });
  });

  it("reconnects at once after a revocation and learns the new role", async () => {
    const { socket, provider, fetchToken } = setup("editor");
    provider.connect();
    await flush();
    socket.accept();
    fetchToken.mockResolvedValueOnce({ token: "later", role: "viewer" });
    socket.fire("revoked", { reason: "role-changed" });
    socket.drop("io server disconnect");
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(fetchToken).toHaveBeenCalledTimes(2);
    socket.accept();
    expect(provider.getSnapshot()).toMatchObject({ role: "viewer", readOnly: true });
  });

  it("is denied after a removal: the next token request is refused", async () => {
    const { socket, provider, fetchToken } = setup("editor");
    provider.connect();
    await flush();
    socket.accept();
    fetchToken.mockRejectedValueOnce(new CollabAccessError(404));
    socket.fire("revoked", { reason: "removed" });
    socket.drop("io server disconnect");
    await vi.advanceTimersByTimeAsync(0);
    await flush();
    expect(provider.getSnapshot().state).toBe("denied");
  });

  describe("going offline", () => {
    it("disconnects, keeps edits, reports them unsynced, and syncs them on reconnect", async () => {
      const { doc, socket, network, provider } = setup();
      provider.connect();
      await flush();
      socket.accept();
      socket.fire("sync", stepTwoOf(new Y.Doc()));
      socket.fire("sync", stepOneOf(new Y.Doc()));
      expect(provider.getSnapshot()).toMatchObject({ state: "connected", synced: true });
      expect(provider.getSnapshot().unsynced).toBe(false);

      network.set(false);
      expect(socket.disconnectCalls).toBe(1);
      expect(provider.getSnapshot()).toMatchObject({ state: "offline", synced: false });
      doc.getText("t").insert(0, "while offline");
      expect(provider.getSnapshot().unsynced).toBe(true);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(socket.connectCalls).toBe(1);

      network.set(true);
      await flush();
      expect(socket.connectCalls).toBe(2);
      socket.accept();
      socket.emitted.length = 0;
      socket.fire("sync", stepTwoOf(new Y.Doc()));
      expect(provider.getSnapshot().unsynced).toBe(true);
      socket.fire("sync", stepOneOf(new Y.Doc()));
      const reply = socket.sent("sync")[0];
      expect(reply && messageType(reply)).toBe(syncProtocol.messageYjsSyncStep2);
      expect(provider.getSnapshot().unsynced).toBe(false);
    });

    it("starts offline when the browser is offline, without calling the server", async () => {
      const network = new FakeNetwork();
      network.online = false;
      const doc = new Y.Doc();
      const socket = new FakeSocket();
      const fetchToken = vi.fn(async () => ({ token: "t", role: "editor" as const }));
      const provider = new CollabProvider({
        documentId: "d",
        doc,
        url: "x",
        fetchToken,
        createSocket: () => socket,
        network,
      });
      provider.connect();
      await flush();
      expect(provider.getSnapshot().state).toBe("offline");
      expect(fetchToken).not.toHaveBeenCalled();
    });

    it("clears remote cursors when the connection drops", async () => {
      const { socket, provider } = setup();
      provider.connect();
      await flush();
      socket.accept();
      const remote = new Y.Doc();
      const remoteAwareness = new awarenessProtocol.Awareness(remote);
      remoteAwareness.setLocalStateField("user", { name: "other" });
      socket.fire(
        "awareness",
        awarenessProtocol.encodeAwarenessUpdate(remoteAwareness, [remote.clientID]),
      );
      expect(provider.awareness.getStates().has(remote.clientID)).toBe(true);
      socket.drop("transport close");
      expect(provider.awareness.getStates().has(remote.clientID)).toBe(false);
    });
  });

  it("announces its own awareness on connect with a clock the server will accept", async () => {
    const { socket, provider } = setup();
    provider.awareness.setLocalStateField("user", { name: "me" });
    const before = provider.awareness.meta.get(provider.doc.clientID)?.clock ?? 0;
    provider.connect();
    await flush();
    socket.accept();
    // The server bumps a departed client's clock by one when it removes it, so a
    // reconnecting client must announce itself with at least two more.
    const after = provider.awareness.meta.get(provider.doc.clientID)?.clock ?? 0;
    expect(after).toBeGreaterThanOrEqual(before + 2);
    expect(socket.sent("awareness")).not.toHaveLength(0);
  });

  it("announces nothing on connect while the state names no user", async () => {
    // The server refuses a presence state without a user, so an empty one stays home.
    const { socket, provider } = setup();
    provider.connect();
    await flush();
    socket.accept();
    expect(socket.sent("awareness")).toEqual([]);
    provider.awareness.setLocalStateField("user", { id: "u1", name: "me" });
    expect(socket.sent("awareness")).toHaveLength(1);
  });

  it("stops everything on destroy", async () => {
    const { socket, provider, fetchToken } = setup();
    provider.connect();
    await flush();
    socket.accept();
    provider.destroy();
    expect(socket.disconnectCalls).toBeGreaterThan(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchToken).toHaveBeenCalledTimes(1);
  });
});
