import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  TestClient,
  cleanup,
  closeDb,
  createDocument,
  db,
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

async function waitForRows(documentId: string, count: number): Promise<void> {
  await waitFor(async () => (await updateRows(documentId)).length >= count, `${count} log rows`);
}

describe("persistence", () => {
  it("restores exactly what the clients had after a server restart", async () => {
    const first = await launch();
    const f = await createDocument();
    const a = await TestClient.connect(first, f, "owner", "owner");
    const b = await TestClient.connect(first, f, "editor", "editor");
    a.insert(0, "one ");
    b.insert(0, "two ");
    a.append("three");
    b.doc.getMap("m").set("k", { nested: [1, 2, 3] });
    await waitFor(() => a.text === b.text && a.text.length === 13, "convergence");
    const had = Y.encodeStateAsUpdate(a.doc);
    // The server has received everything once its own copy matches.
    await waitFor(
      () => first.registry.get(f.documentId)?.doc.getText("text").toString() === a.text,
      "the server copy",
    );
    a.close();
    b.close();
    await first.close();

    const second = await launch();
    const late = await TestClient.connect(second, f, "viewer", "viewer");
    expect(late.text).toBe(a.text);
    expect(late.doc.getMap("m").toJSON()).toEqual({ k: { nested: [1, 2, 3] } });
    // The state is the same document, not merely the same text.
    const restored = new Y.Doc();
    Y.applyUpdate(restored, Y.encodeStateAsUpdate(late.doc));
    expect(Y.encodeStateVector(restored)).toEqual(Y.encodeStateVector(a.doc));
    expect(had.byteLength).toBeGreaterThan(0);
  });

  it("appends every accepted update with strictly increasing seq", async () => {
    const server = await launch();
    const f = await createDocument();
    const a = await TestClient.connect(server, f, "owner", "owner");
    for (let i = 0; i < 25; i += 1) a.append(String(i % 10));
    await waitForRows(f.documentId, 25);
    const rows = await updateRows(f.documentId);
    expect(rows.map((r) => r.seq)).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));
    expect(await storedText(f.documentId)).toBe(a.text);
  });

  it("compacts into a snapshot after N updates, trims the log and keeps seq increasing", async () => {
    const server = await launch({ persistence: { compactEveryUpdates: 5 } });
    const f = await createDocument();
    const a = await TestClient.connect(server, f, "owner", "owner");
    for (let i = 0; i < 12; i += 1) {
      a.append(`${i},`);
      await settle(20);
    }
    await waitFor(async () => (await snapshotRows(f.documentId)).length > 0, "a snapshot");
    await waitFor(
      async () => (await updateRows(f.documentId)).length < 12,
      "the log to be trimmed behind the snapshot",
    );
    const snapshots = await snapshotRows(f.documentId);
    expect(snapshots).toHaveLength(1);
    const snapshot = snapshots[0]!;
    expect(snapshot.upToSeq).toBeGreaterThanOrEqual(5);
    for (const row of await updateRows(f.documentId))
      expect(row.seq).toBeGreaterThan(snapshot.upToSeq);
    expect(await storedText(f.documentId)).toBe(a.text);

    // Sequence numbers go on after the trim.
    a.append("after");
    const before = snapshot.upToSeq;
    await waitFor(async () => (await storedText(f.documentId)) === a.text, "the later update");
    const rows = await updateRows(f.documentId);
    const snaps = await snapshotRows(f.documentId);
    expect(rows.every((r) => r.seq > snaps[0]!.upToSeq)).toBe(true);
    expect(Math.max(snaps[0]!.upToSeq, ...rows.map((r) => r.seq))).toBeGreaterThan(before);
  });

  it("compacts after T milliseconds even when N is far away", async () => {
    const server = await launch({
      persistence: { compactEveryUpdates: 1000, compactAfterMs: 150 },
    });
    const f = await createDocument();
    const a = await TestClient.connect(server, f, "owner", "owner");
    a.insert(0, "timed");
    await waitForRows(f.documentId, 1);
    await waitFor(async () => (await snapshotRows(f.documentId)).length === 1, "a timed snapshot");
    await waitFor(async () => (await updateRows(f.documentId)).length === 0, "an empty log");
    expect(await storedText(f.documentId)).toBe("timed");
  });

  it("loads the latest snapshot plus the updates after it", async () => {
    const first = await launch({ persistence: { compactEveryUpdates: 3 } });
    const f = await createDocument();
    const a = await TestClient.connect(first, f, "owner", "owner");
    for (let i = 0; i < 7; i += 1) {
      a.append(String(i));
      await settle(20);
    }
    await waitFor(async () => (await storedText(f.documentId)) === "0123456", "all seven updates");
    a.close();
    await first.close();
    expect(await snapshotRows(f.documentId)).toHaveLength(1);
    expect(await updateRows(f.documentId)).toHaveLength(0);

    // A log tail written behind the snapshot, as a crashed instance would leave one.
    const second = await launch();
    const tail = new Y.Doc();
    tail.getText("text").insert(0, "[tail]");
    await second.store.append(f.documentId, [Y.encodeStateAsUpdate(tail)]);
    expect(await updateRows(f.documentId)).toHaveLength(1);

    const reader = await TestClient.connect(second, f, "owner", "owner");
    expect(reader.text).toContain("0123456");
    expect(reader.text).toContain("[tail]");
  });

  it("keeps a document in memory through the grace period and unloads it after", async () => {
    const server = await launch({ persistence: { unloadGraceMs: 300 } });
    const f = await createDocument();
    const a = await TestClient.connect(server, f, "owner", "owner");
    a.insert(0, "keep");
    await waitForRows(f.documentId, 1);
    const entry = server.registry.get(f.documentId);
    a.close();
    await waitFor(() => entry?.sockets.size === 0, "the socket to leave");
    await settle(100);
    // Back within the grace period: the same in-memory document.
    const b = await TestClient.connect(server, f, "owner", "owner");
    expect(server.registry.get(f.documentId)).toBe(entry);
    expect(b.text).toBe("keep");
    b.close();
    await waitFor(() => server.registry.get(f.documentId) === undefined, "the document to unload");
    // Unloading wrote a snapshot of what was uncompacted.
    expect(await snapshotRows(f.documentId)).toHaveLength(1);
    const c = await TestClient.connect(server, f, "owner", "owner");
    expect(c.text).toBe("keep");
    expect(server.registry.get(f.documentId)).not.toBe(entry);
  });

  it("drops a document and disconnects its sockets when the log cannot be written", async () => {
    const server = await launch();
    const f = await createDocument();
    const a = await TestClient.connect(server, f, "owner", "owner");
    const b = await TestClient.connect(server, f, "editor", "editor");
    // The document is deleted underneath the server: the foreign key refuses the append.
    await db().query('DELETE FROM "Document" WHERE "id" = $1', [f.documentId]);
    a.insert(0, "lost");
    await waitFor(() => !a.connected && !b.connected, "both sockets to be disconnected");
    await waitFor(() => server.registry.get(f.documentId) === undefined, "the entry to be dropped");
    expect(server.logs.records.some((r) => r.message.includes("update log write failed"))).toBe(
      true,
    );
  });

  it("flushes queued updates when the server closes", async () => {
    const server = await launch();
    const f = await createDocument();
    const a = await TestClient.connect(server, f, "owner", "owner");
    for (let i = 0; i < 40; i += 1) a.append("z");
    await waitFor(
      () => server.registry.get(f.documentId)?.doc.getText("text").length === 40,
      "the server copy",
    );
    await server.close();
    expect(await storedText(f.documentId)).toBe("z".repeat(40));
  });
});
