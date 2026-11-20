import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  TestClient,
  cleanup,
  closeDb,
  createDocument,
  launch,
  redisClient,
  resetDb,
  settle,
  storedText,
  updateRows,
  waitFor,
  connectErrorOf,
} from "./support";

beforeEach(resetDb);
afterEach(cleanup);
afterAll(closeDb);

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

type Server = Awaited<ReturnType<typeof launch>>;

/**
 * Updates as a client would produce them, in order: the first one is the one a
 * misbehaving client withholds, so that every later one has a missing dependency.
 */
function gappedUpdates(count: number, size: number): { first: Uint8Array; rest: Uint8Array[] } {
  const doc = new Y.Doc();
  const updates: Uint8Array[] = [];
  doc.on("update", (update: Uint8Array) => updates.push(update));
  const text = doc.getText("text");
  text.insert(0, "a");
  for (let i = 0; i < count; i += 1) text.insert(text.length, "g".repeat(size));
  return { first: updates[0]!, rest: updates.slice(1) };
}

const pendingOf = (server: Server, documentId: string): number => {
  const store = server.registry.get(documentId)!.doc.store;
  return (store.pendingStructs?.update.byteLength ?? 0) + (store.pendingDs?.byteLength ?? 0);
};

describe("updates whose dependencies are missing count like any other", () => {
  it("counts them against the document cap as soon as they arrive", async () => {
    const server = await launch({
      limits: { maxDocumentBytes: 5000, maxPendingStructBytes: 1_000_000 },
    });
    const f = await createDocument();
    const writer = await TestClient.connect(server, f, "owner", "owner", { manual: true });
    const { rest } = gappedUpdates(6, 1500);
    for (const update of rest) writer.forceSend(update);
    await waitFor(() => writer.rejected.length > 0, "a rejection");
    expect(writer.rejected[0]).toEqual({ event: "sync", reason: "document_full" });
    // Nothing was written or shown to anyone: the updates are held back, and bounded.
    expect(await updateRows(f.documentId)).toHaveLength(0);
    expect(pendingOf(server, f.documentId)).toBeLessThanOrEqual(5000);
  });

  it("counts them against the pending-bytes bound and closes the socket past it", async () => {
    const server = await launch({
      limits: { maxPendingBytes: 4000, maxPendingStructBytes: 1_000_000 },
    });
    const f = await createDocument();
    const writer = await TestClient.connect(server, f, "owner", "owner", { manual: true });
    const { rest } = gappedUpdates(6, 1500);
    for (const update of rest) writer.forceSend(update);
    await waitFor(() => !writer.connected, "the writer to be disconnected");
    expect(writer.rejected).toContainEqual({ event: "sync", reason: "overloaded" });
    expect(pendingOf(server, f.documentId)).toBeLessThanOrEqual(4000);
  });

  it("caps the unresolved structure per document, says why and closes the socket", async () => {
    const server = await launch({ limits: { maxPendingStructBytes: 3000 } });
    const f = await createDocument();
    const writer = await TestClient.connect(server, f, "owner", "owner", { manual: true });
    const { rest } = gappedUpdates(20, 1000);
    for (const update of rest) writer.forceSend(update);
    await waitFor(() => !writer.connected, "the writer to be disconnected");
    expect(writer.rejected).toContainEqual({ event: "sync", reason: "overloaded" });
    expect(server.logs.find("unresolved updates over the cap; disconnecting")).toHaveLength(1);
    // The held structure is dropped, so the memory is not kept.
    expect(pendingOf(server, f.documentId)).toBe(0);
  });

  it("still applies, persists and relays them once the missing update arrives", async () => {
    const server = await launch();
    const f = await createDocument();
    const writer = await TestClient.connect(server, f, "owner", "owner", { manual: true });
    const reader = await TestClient.connect(server, f, "viewer", "viewer");
    const { first, rest } = gappedUpdates(3, 100);
    for (const update of rest) writer.forceSend(update);
    await settle(200);
    expect(reader.text).toBe("");
    writer.forceSend(first);
    await waitFor(() => reader.text.length === 301, "the whole text to arrive");
    await waitFor(async () => (await updateRows(f.documentId)).length > 0, "the log");
    expect(pendingOf(server, f.documentId)).toBe(0);
  });
});

describe("the document cap tracks what the database holds", () => {
  const limits = { maxDocumentBytes: 5000 };

  async function fill(
    server: Server,
    documentId: string,
    fixture: Awaited<ReturnType<typeof createDocument>>,
  ) {
    const writer = await TestClient.connect(server, fixture, "owner", "owner");
    for (let i = 0; i < 3; i += 1) writer.append("y".repeat(1500));
    await waitFor(async () => (await updateRows(documentId)).length === 3, "three log rows");
    return writer;
  }

  it("starts from what is stored when a full document is loaded again", async () => {
    const first = await launch({ limits });
    const f = await createDocument();
    await fill(first, f.documentId, f);
    await first.close();

    const second = await launch({ limits });
    const writer = await TestClient.connect(second, f, "owner", "owner");
    expect(writer.text).toHaveLength(4500);
    writer.append("z".repeat(1500));
    await waitFor(() => writer.rejected.length === 1, "a rejection");
    expect(writer.rejected[0]).toEqual({ event: "sync", reason: "document_full" });
  });

  it("makes room again after a compaction shrinks what is stored", async () => {
    const server = await launch({ limits, persistence: { compactEveryUpdates: 1000 } });
    const f = await createDocument();
    const writer = await TestClient.connect(server, f, "owner", "owner");
    const text = writer.doc.getText("text");
    // Insert and delete: the log grows, the document stays small, a snapshot is tiny.
    for (let i = 0; i < 3; i += 1) {
      text.insert(0, "y".repeat(1500));
      text.delete(0, 1500);
    }
    await waitFor(async () => (await updateRows(f.documentId)).length === 6, "six log rows");
    writer.append("w".repeat(1500));
    await waitFor(() => writer.rejected.length === 1, "a rejection while the log is full");
    expect(writer.rejected[0]).toEqual({ event: "sync", reason: "document_full" });
    // The refusal asked for a compaction; once it is done the count has dropped.
    await waitFor(() => server.logs.find("document compacted").length > 0, "the compaction");
    await settle(100);
    // A fresh client: the refused text is in the first one's document, and anything it
    // sends from now on depends on it.
    const next = await TestClient.connect(server, f, "editor", "editor");
    next.append("v".repeat(1500));
    await waitFor(
      async () => (await server.store.storedBytes(f.documentId)) > 1500,
      "an accepted write",
    );
    expect(next.rejected).toHaveLength(0);
  });

  it("counts what other instances append, after the next reconcile", async () => {
    const a = await launch({
      limits,
      persistence: { reconcileIntervalMs: 100, membershipRecheckMs: 60_000, unloadGraceMs: 60_000 },
    });
    const b = await launch({ limits });
    const f = await createDocument();
    const onA = await TestClient.connect(a, f, "editor", "editor");
    await fill(b, f.documentId, f);
    await waitFor(() => onA.text.length === 4500, "instance A to read the log");
    await settle(150);
    onA.append("z".repeat(1500));
    await waitFor(() => onA.rejected.length === 1, "a rejection");
    expect(onA.rejected[0]).toEqual({ event: "sync", reason: "document_full" });
  });

  it("lets edits that only delete through, so a full document can be made smaller", async () => {
    const first = await launch();
    const f = await createDocument();
    const writer = await TestClient.connect(first, f, "owner", "owner");
    writer.append("d".repeat(3000));
    await waitFor(async () => (await updateRows(f.documentId)).length === 1, "the log row");
    await first.store.compact(f.documentId);
    const stored = await first.store.storedBytes(f.documentId);
    await first.close();

    // The cap is a few bytes above what the snapshot holds: no update fits, deletions included.
    const second = await launch({
      limits: { maxDocumentBytes: stored + 4 },
      persistence: { compactEveryUpdates: 1, compactAfterMs: 100 },
    });
    const editor = await TestClient.connect(second, f, "owner", "owner");
    editor.doc.getText("text").delete(0, 3000);
    await waitFor(
      () => second.registry.get(f.documentId)?.doc.getText("text").length === 0,
      "the deletion to be applied",
    );
    expect(editor.rejected).toHaveLength(0);
    // After the compaction there is room again.
    await waitFor(
      async () => (await second.store.storedBytes(f.documentId)) < 100,
      "a small snapshot",
    );
    await settle(100);
    editor.append("fresh");
    await waitFor(async () => (await storedText(f.documentId)) === "fresh", "the new text");
    expect(editor.rejected).toHaveLength(0);
  });
});

describe("the membership check on a write", () => {
  const persistence = {
    roleCacheMs: 1,
    reconcileIntervalMs: 60_000,
    membershipRecheckMs: 60_000,
    unloadGraceMs: 60_000,
  };

  it("fails closed when the database cannot answer", async () => {
    const server = await launch({ persistence });
    const f = await createDocument();
    const editor = await TestClient.connect(server, f, "editor", "editor");
    await settle(10);
    server.store.role = () => Promise.reject(new Error("database down"));
    editor.append("must not be stored");
    await waitFor(() => !editor.connected, "the socket to be closed");
    await settle(150);
    expect(server.logs.find("membership check failed; disconnecting")).toHaveLength(1);
    expect(await updateRows(f.documentId)).toHaveLength(0);
    expect(server.registry.get(f.documentId)?.doc.getText("text").toString() ?? "").toBe("");
  });

  it("drops a write whose socket was revoked while the check was running", async () => {
    const server = await launch({ persistence });
    const f = await createDocument();
    const editor = await TestClient.connect(server, f, "editor", "editor");
    await settle(10);
    const real = server.store.role.bind(server.store);
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    server.store.role = async (documentId, userId) => {
      await gate;
      return real(documentId, userId);
    };
    editor.append("too late");
    await settle(100);
    // The revocation arrives (a membership message) while the query is in flight.
    server.registry.revoke({
      documentId: f.documentId,
      userId: f.users.editor!,
      change: "removed",
    });
    await waitFor(() => !editor.connected, "the socket to be closed");
    release();
    await settle(300);
    expect(await updateRows(f.documentId)).toHaveLength(0);
    expect(server.registry.get(f.documentId)?.doc.getText("text").toString()).toBe("");
  });
});

describe("a frozen Redis", () => {
  it("fails a handshake promptly instead of waiting for Redis", async () => {
    const server = await launch({ redis: true });
    const f = await createDocument();
    const admin = redisClient();
    await admin.client("PAUSE", "6000", "ALL");
    try {
      const started = Date.now();
      const error = await connectErrorOf(server, f, "owner", "owner");
      expect(error.code).toBe("server_error");
      expect(Date.now() - started).toBeLessThan(4500);
    } finally {
      await admin.client("UNPAUSE");
      await sleep(50);
    }
  });
});
