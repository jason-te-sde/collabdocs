import { encodeMembershipChange } from "@collabdocs/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  TestClient,
  cleanup,
  closeDb,
  connectErrorOf,
  createDocument,
  holdAppends,
  launch,
  publishMembership,
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

async function pair(options: Parameters<typeof launch>[0] = {}) {
  const a = await launch({ redis: true, instanceId: "A", ...options });
  const b = await launch({ redis: true, instanceId: "B", ...options });
  return { a, b };
}

describe("two instances behind Redis", () => {
  it("keeps clients on different instances converged and persists each update once", async () => {
    const { a, b } = await pair();
    const f = await createDocument();
    const onA = await TestClient.connect(a, f, "owner", "owner");
    const onB = await TestClient.connect(b, f, "editor", "editor");

    // Concurrent edits from both sides, each its own Yjs transaction.
    for (let i = 0; i < 5; i += 1) {
      onA.append(`a${i} `);
      onB.append(`b${i} `);
    }
    await waitFor(() => onA.text.length === 30 && onA.text === onB.text, "both texts to converge");
    // Exactly one log row per transaction: 5 from each side, none doubled.
    await waitFor(async () => (await updateRows(f.documentId)).length >= 10, "ten rows");
    await settle(300);
    const rows = await updateRows(f.documentId);
    expect(rows).toHaveLength(10);
    expect(rows.map((r) => r.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(await storedText(f.documentId)).toBe(onA.text);
    // Both server copies agree with the clients.
    expect(a.registry.get(f.documentId)!.doc.getText("text").toString()).toBe(onA.text);
    expect(b.registry.get(f.documentId)!.doc.getText("text").toString()).toBe(onA.text);
  });

  it("gives a late joiner on the other instance the full state", async () => {
    const { a, b } = await pair();
    const f = await createDocument();
    const onA = await TestClient.connect(a, f, "owner", "owner");
    onA.insert(0, "written on A");
    await waitFor(async () => (await storedText(f.documentId)) === "written on A", "the log");
    const late = await TestClient.connect(b, f, "viewer", "viewer");
    expect(late.text).toBe("written on A");
    onA.append("!");
    await waitFor(() => late.text === "written on A!", "a live update across instances");
  });

  it("does not let a viewer on one instance change the document on the other", async () => {
    const { a, b } = await pair();
    const f = await createDocument();
    const editor = await TestClient.connect(a, f, "editor", "editor");
    editor.insert(0, "safe");
    const viewer = await TestClient.connect(b, f, "viewer", "viewer", { manual: true });
    await waitFor(() => viewer.text === "safe", "the viewer to sync");
    const forged = new Y.Doc();
    Y.applyUpdate(forged, Y.encodeStateAsUpdate(viewer.doc));
    forged.getText("text").insert(0, "EVIL ");
    viewer.forceSend(Y.encodeStateAsUpdate(forged, Y.encodeStateVector(viewer.doc)));
    await waitFor(() => viewer.rejected.length === 1, "the rejection");
    await settle(300);
    expect(editor.text).toBe("safe");
    expect(await storedText(f.documentId)).toBe("safe");
    expect(b.logs.find("message rejected")).toHaveLength(1);
  });

  it("shares presence across instances, and removes it when the client leaves", async () => {
    const { a, b } = await pair();
    const f = await createDocument();
    const onA = await TestClient.connect(a, f, "owner", "owner");
    const onB = await TestClient.connect(b, f, "editor", "editor");
    onA.awareness.setLocalState(onA.state({ name: "Ada" }));
    await waitFor(
      () => onB.awareness.getStates().get(onA.doc.clientID)?.name === "Ada",
      "presence on B",
    );
    const lateOnB = await TestClient.connect(b, f, "viewer", "viewer");
    await waitFor(
      () => lateOnB.awareness.getStates().get(onA.doc.clientID)?.name === "Ada",
      "presence for a joiner on B",
    );
    onA.close();
    await waitFor(
      () => !onB.awareness.getStates().has(onA.doc.clientID),
      "presence to be removed on B",
    );
  });

  it("repairs a missed relay from the log", async () => {
    const { a, b } = await pair({ persistence: { reconcileIntervalMs: 100 } });
    const f = await createDocument();
    const onB = await TestClient.connect(b, f, "owner", "owner");
    await TestClient.connect(a, f, "editor", "editor");
    // An update that reached the log but whose relay was lost: written without going through a socket.
    const lost = new Y.Doc();
    lost.getText("text").insert(0, "relay lost");
    await a.store.append(f.documentId, [Y.encodeStateAsUpdate(lost)]);
    await waitFor(() => onB.text === "relay lost", "the reconcile to deliver it");
  });

  it("repairs a missed relay even when compaction already trimmed the log", async () => {
    const { a, b } = await pair({ persistence: { reconcileIntervalMs: 150 } });
    const f = await createDocument();
    const onB = await TestClient.connect(b, f, "owner", "owner");
    const lost = new Y.Doc();
    lost.getText("text").insert(0, "folded away");
    await a.store.append(f.documentId, [Y.encodeStateAsUpdate(lost)]);
    expect(await a.store.compact(f.documentId)).toMatchObject({ folded: 1 });
    expect(await updateRows(f.documentId)).toHaveLength(0);
    await waitFor(() => onB.text === "folded away", "the snapshot to be delivered");
  });

  it("compacts safely from both instances at once", async () => {
    const { a, b } = await pair({ persistence: { compactEveryUpdates: 4 } });
    const f = await createDocument();
    const onA = await TestClient.connect(a, f, "owner", "owner");
    const onB = await TestClient.connect(b, f, "editor", "editor");
    for (let i = 0; i < 20; i += 1) {
      (i % 2 === 0 ? onA : onB).append(String(i % 10));
      await settle(15);
    }
    await waitFor(() => onA.text.length === 20 && onA.text === onB.text, "convergence");
    await waitFor(
      async () => (await storedText(f.documentId)) === onA.text,
      "the stored text to match",
    );
    expect((await snapshotRows(f.documentId)).length).toBe(1);
    const rows = await updateRows(f.documentId);
    const [snap] = await snapshotRows(f.documentId);
    expect(rows.every((r) => r.seq > snap!.upToSeq)).toBe(true);
    // A third client, fresh from the database, sees the same document.
    await a.close();
    await b.close();
    const c = await launch();
    const fresh = await TestClient.connect(c, f, "viewer", "viewer");
    expect(fresh.text).toBe(onA.text);
  });

  it("counts the connection limit across instances", async () => {
    const { a, b } = await pair({ limits: { maxConnectionsPerDocument: 2 } });
    const f = await createDocument();
    await TestClient.connect(a, f, "owner", "owner");
    await TestClient.connect(b, f, "editor", "editor");
    expect((await connectErrorOf(a, f, "viewer", "viewer")).code).toBe("too_many_connections");
    expect((await connectErrorOf(b, f, "viewer", "viewer")).code).toBe("too_many_connections");
  });

  it("disconnects a removed member from both instances with one message", async () => {
    const { a, b } = await pair();
    const f = await createDocument();
    const onA = await TestClient.connect(a, f, "editor", "editor");
    const onB = await TestClient.connect(b, f, "editor", "editor");
    const bystander = await TestClient.connect(b, f, "viewer", "viewer");
    await publishMembership(
      encodeMembershipChange({
        documentId: f.documentId,
        userId: f.users.editor!,
        change: "removed",
      }),
    );
    await waitFor(() => !onA.connected && !onB.connected, "both sockets to be disconnected");
    expect(bystander.connected).toBe(true);
  });

  it("survives an instance going away: the other keeps serving and the state is intact", async () => {
    const { a, b } = await pair();
    const f = await createDocument();
    const onA = await TestClient.connect(a, f, "owner", "owner");
    const onB = await TestClient.connect(b, f, "editor", "editor");
    onA.insert(0, "before ");
    await waitFor(() => onB.text === "before ", "the first update");
    await a.close();
    onB.append("after");
    await waitFor(async () => (await storedText(f.documentId)) === "before after", "the log");
    const late = await TestClient.connect(b, f, "viewer", "viewer");
    expect(late.text).toBe("before after");
  });

  it("relays an update to the other instance only after the append has committed", async () => {
    const { a, b } = await pair();
    const f = await createDocument();
    const onA = await TestClient.connect(a, f, "owner", "owner");
    const onB = await TestClient.connect(b, f, "viewer", "viewer");
    const { release } = holdAppends(a);

    onA.insert(0, "not yet durable");
    // Instance A has applied it and told its own client's peers, but the log write is stuck.
    await waitFor(
      () => a.registry.get(f.documentId)?.doc.getText("text").toString() === "not yet durable",
      "the update to reach instance A",
    );
    await settle(500);
    expect(onB.text).toBe("");
    expect(await updateRows(f.documentId)).toHaveLength(0);

    release();
    await waitFor(
      () => onB.text === "not yet durable",
      "the update to be relayed after the append",
    );
    expect(await updateRows(f.documentId)).toHaveLength(1);
  });
});
