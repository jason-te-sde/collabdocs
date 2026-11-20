import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as awarenessProtocol from "y-protocols/awareness";
import * as Y from "yjs";
import {
  TestClient,
  cleanup,
  closeDb,
  createDocument,
  launch,
  resetDb,
  settle,
  waitFor,
} from "./support";

beforeEach(resetDb);
afterEach(cleanup);
afterAll(closeDb);

/** An awareness update as a client with these ids would send it; `state: null` removes the id. */
function craft(entries: Array<{ id: number; state: unknown }>, clock = 50): Uint8Array {
  const doc = new Y.Doc();
  const awareness = new awarenessProtocol.Awareness(doc);
  const encoded: number[] = [];
  for (const { id, state } of entries) {
    const other = new awarenessProtocol.Awareness(Object.assign(new Y.Doc(), { clientID: id }));
    for (let i = 0; i < clock; i += 1) other.setLocalState({ i });
    other.setLocalState(state as Record<string, unknown> | null);
    awarenessProtocol
      .encodeAwarenessUpdate(other, [id])
      .forEach((byte, index) => index >= 1 && encoded.push(byte));
    other.destroy();
  }
  awareness.destroy();
  const header: number[] = [];
  // The count of states as a varuint (always below 128 here), then the states.
  header.push(entries.length);
  return Uint8Array.from([...header, ...encoded]);
}

const presenceOf = (
  server: { registry: { get(id: string): { awareness: awarenessProtocol.Awareness } | undefined } },
  documentId: string,
  id: number,
) => server.registry.get(documentId)?.awareness.getStates().get(id);

describe("awareness is bound to the user who announced it", () => {
  it("does not let a viewer overwrite or erase another user's presence", async () => {
    const server = await launch();
    const f = await createDocument();
    const ada = await TestClient.connect(server, f, "owner", "owner");
    const viewer = await TestClient.connect(server, f, "viewer", "viewer");
    ada.awareness.setLocalState({ name: "Ada" });
    await waitFor(() => viewer.awareness.getStates().get(ada.doc.clientID)?.name === "Ada", "Ada");

    viewer.socket.emit("awareness", craft([{ id: ada.doc.clientID, state: { name: "Mallory" } }]));
    await waitFor(() => viewer.rejected.length === 1, "a rejection");
    viewer.socket.emit("awareness", craft([{ id: ada.doc.clientID, state: null }], 60));
    await waitFor(() => viewer.rejected.length === 2, "a second rejection");
    expect(viewer.rejected.every((r) => r.event === "awareness" && r.reason === "forbidden")).toBe(
      true,
    );
    await settle(200);
    expect(presenceOf(server, f.documentId, ada.doc.clientID)).toEqual({ name: "Ada" });
    expect(ada.awareness.getStates().get(ada.doc.clientID)).toEqual({ name: "Ada" });
  });

  it("refuses a message that mixes the sender's own id with someone else's", async () => {
    const server = await launch();
    const f = await createDocument();
    const ada = await TestClient.connect(server, f, "owner", "owner");
    const viewer = await TestClient.connect(server, f, "viewer", "viewer");
    ada.awareness.setLocalState({ name: "Ada" });
    await waitFor(() => viewer.awareness.getStates().get(ada.doc.clientID)?.name === "Ada", "Ada");
    viewer.socket.emit(
      "awareness",
      craft([
        { id: 4242, state: { name: "mine" } },
        { id: ada.doc.clientID, state: { name: "Mallory" } },
      ]),
    );
    await waitFor(() => viewer.rejected.length === 1, "a rejection");
    expect(viewer.rejected[0]?.reason).toBe("forbidden");
    await settle(150);
    // All or nothing: the viewer's own entry was not applied either.
    expect(presenceOf(server, f.documentId, 4242)).toBeUndefined();
    expect(presenceOf(server, f.documentId, ada.doc.clientID)).toEqual({ name: "Ada" });
  });

  it("limits how many ids one socket may announce", async () => {
    const server = await launch();
    const f = await createDocument();
    const viewer = await TestClient.connect(server, f, "viewer", "viewer");
    viewer.socket.emit(
      "awareness",
      craft(Array.from({ length: 8 }, (_, i) => ({ id: 1000 + i, state: { n: i } }))),
    );
    await waitFor(() => presenceOf(server, f.documentId, 1007) !== undefined, "eight ids");
    viewer.socket.emit("awareness", craft([{ id: 2000, state: { n: 9 } }]));
    await waitFor(() => viewer.rejected.length === 1, "a rejection of the ninth id");
    expect(viewer.rejected[0]?.reason).toBe("forbidden");
    expect(presenceOf(server, f.documentId, 2000)).toBeUndefined();
    // Ids it already announced stay updatable.
    viewer.socket.emit("awareness", craft([{ id: 1000, state: { n: "again" } }], 70));
    await waitFor(() => presenceOf(server, f.documentId, 1000)?.n === "again", "an update");
  });

  it("caps the size of an awareness message at 8 KiB by default", async () => {
    const server = await launch();
    const f = await createDocument();
    const viewer = await TestClient.connect(server, f, "viewer", "viewer");
    viewer.awareness.setLocalState({ blob: "z".repeat(9000) });
    await waitFor(() => viewer.rejected.length === 1, "a rejection");
    expect(viewer.rejected[0]).toEqual({ event: "awareness", reason: "too_large" });
    viewer.awareness.setLocalState({ blob: "z".repeat(4000) });
    await waitFor(
      () => presenceOf(server, f.documentId, viewer.doc.clientID) !== undefined,
      "a state under the cap",
    );
  });

  it("lets the same user take an id over from an older socket without losing it", async () => {
    const server = await launch();
    const f = await createDocument();
    const old = await TestClient.connect(server, f, "owner", "owner");
    old.awareness.setLocalState({ name: "before" });
    await waitFor(() => presenceOf(server, f.documentId, old.doc.clientID) !== undefined, "state");
    const fresh = await TestClient.connect(server, f, "owner", "owner");
    fresh.socket.emit("awareness", craft([{ id: old.doc.clientID, state: { name: "after" } }], 80));
    await waitFor(
      () => presenceOf(server, f.documentId, old.doc.clientID)?.name === "after",
      "the takeover",
    );
    old.close();
    await settle(300);
    expect(presenceOf(server, f.documentId, old.doc.clientID)?.name).toBe("after");
  });

  it("holds across instances: a viewer on one cannot erase a user on the other", async () => {
    const a = await launch({ redis: true, instanceId: "A" });
    const b = await launch({ redis: true, instanceId: "B" });
    const f = await createDocument();
    const ada = await TestClient.connect(a, f, "owner", "owner");
    const viewer = await TestClient.connect(b, f, "viewer", "viewer");
    ada.awareness.setLocalState({ name: "Ada" });
    await waitFor(() => viewer.awareness.getStates().get(ada.doc.clientID)?.name === "Ada", "Ada");
    viewer.socket.emit("awareness", craft([{ id: ada.doc.clientID, state: null }], 90));
    await waitFor(() => viewer.rejected.length === 1, "a rejection on instance B");
    expect(viewer.rejected[0]?.reason).toBe("forbidden");
    await settle(200);
    expect(presenceOf(b, f.documentId, ada.doc.clientID)).toEqual({ name: "Ada" });
    expect(presenceOf(a, f.documentId, ada.doc.clientID)).toEqual({ name: "Ada" });
  });
});
