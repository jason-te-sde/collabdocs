import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import {
  TestClient,
  cleanup,
  closeDb,
  createDocument,
  launch,
  resetDb,
  settle,
  storedText,
  updateRows,
  waitFor,
} from "./support";

beforeEach(resetDb);
afterEach(cleanup);
afterAll(closeDb);

describe("sync", () => {
  it("converges two clients that edit at the same time", async () => {
    const server = await launch();
    const f = await createDocument();
    const a = await TestClient.connect(server, f, "owner", "owner");
    const b = await TestClient.connect(server, f, "editor", "editor");

    // Both type at position 0 before either sees the other's edit.
    a.insert(0, "alpha ");
    b.insert(0, "beta ");
    a.append("tail-a");
    b.append("tail-b");

    await waitFor(
      () => a.text.length === b.text.length && a.text.length === 23,
      "both texts to arrive",
    );
    expect(a.text).toBe(b.text);
    for (const part of ["alpha ", "beta ", "tail-a", "tail-b"]) expect(a.text).toContain(part);
  });

  it("gives a late joiner the full state", async () => {
    const server = await launch();
    const f = await createDocument();
    const a = await TestClient.connect(server, f, "owner", "owner");
    a.insert(0, "hello ");
    a.append("world");
    a.doc.getMap("meta").set("title", "T");
    await waitFor(async () => (await storedText(f.documentId)) === "hello world", "the log");

    const late = await TestClient.connect(server, f, "editor", "editor");
    expect(late.text).toBe("hello world");
    expect(late.doc.getMap("meta").get("title")).toBe("T");
  });

  it("brings an editor's offline changes in through the server's sync step 1", async () => {
    const server = await launch();
    const f = await createDocument();
    const owner = await TestClient.connect(server, f, "owner", "owner");
    await TestClient.connect(server, f, "editor", "editor", {
      offline: (doc) => doc.getText("text").insert(0, "typed offline"),
    });
    await waitFor(() => owner.text === "typed offline", "the offline edit to reach the owner");
    await waitFor(async () => (await storedText(f.documentId)) === "typed offline", "the log");
  });

  it("lets a viewer sync, receive and send awareness", async () => {
    const server = await launch();
    const f = await createDocument();
    const editor = await TestClient.connect(server, f, "editor", "editor");
    editor.insert(0, "readable");
    await waitFor(async () => (await storedText(f.documentId)) === "readable", "the log");

    const viewer = await TestClient.connect(server, f, "viewer", "viewer");
    expect(viewer.text).toBe("readable");
    editor.append(" more");
    await waitFor(() => viewer.text === "readable more", "a live update to reach the viewer");

    viewer.awareness.setLocalState(viewer.state({ cursor: "viewer-cursor" }));
    await waitFor(
      () => [...editor.awareness.getStates().values()].some((s) => s.cursor === "viewer-cursor"),
      "the viewer's cursor",
    );
    expect(viewer.rejected).toEqual([]);
  });

  it("rejects a viewer's update, logs it, and changes nothing", async () => {
    const server = await launch();
    const f = await createDocument();
    const editor = await TestClient.connect(server, f, "editor", "editor");
    editor.insert(0, "original");
    const viewer = await TestClient.connect(server, f, "viewer", "viewer", { manual: true });
    await waitFor(() => viewer.text === "original", "the viewer to sync");
    await waitFor(async () => (await updateRows(f.documentId)).length === 1, "the first update");

    const evil = new Y.Doc();
    Y.applyUpdate(evil, Y.encodeStateAsUpdate(viewer.doc));
    evil.getText("text").insert(0, "VIEWER WAS HERE ");
    const update = Y.encodeStateAsUpdate(evil, Y.encodeStateVector(viewer.doc));
    viewer.forceSend(update);
    viewer.forceSendStep2();

    await waitFor(() => viewer.rejected.length === 2, "two rejections");
    expect(viewer.rejected.every((r) => r.reason === "forbidden")).toBe(true);
    await settle();
    expect(editor.text).toBe("original");
    expect(await storedText(f.documentId)).toBe("original");
    expect((await updateRows(f.documentId)).length).toBe(1);
    expect(server.registry.get(f.documentId)?.doc.getText("text").toString()).toBe("original");
    const logged = server.logs.find("message rejected");
    expect(logged).toHaveLength(2);
    expect(logged[0]).toMatchObject({
      documentId: f.documentId,
      userId: f.users.viewer,
      role: "viewer",
      event: "sync",
      reason: "forbidden",
    });
    // The viewer stays connected and can still read.
    expect(viewer.connected).toBe(true);
    editor.append("!");
    await waitFor(() => viewer.text === "original!", "later updates still reach the viewer");
  });

  it("treats a token that says editor but a membership that says viewer as a viewer", async () => {
    const server = await launch();
    const f = await createDocument();
    const client = await TestClient.connect(server, f, "viewer", "viewer", {
      tokenRole: "editor",
      manual: true,
    });
    client.insert(0, "sneaky");
    client.forceSend(Y.encodeStateAsUpdate(client.doc));
    await waitFor(() => client.rejected.length === 1, "the rejection");
    expect(await updateRows(f.documentId)).toHaveLength(0);
  });

  it("shares awareness across clients and drops it when a client leaves", async () => {
    const server = await launch();
    const f = await createDocument();
    const a = await TestClient.connect(server, f, "owner", "owner");
    const b = await TestClient.connect(server, f, "editor", "editor");
    a.awareness.setLocalState(a.state({ name: "Ada" }));
    await waitFor(
      () => b.awareness.getStates().get(a.doc.clientID)?.name === "Ada",
      "A's presence",
    );

    // A late joiner is told who is already here.
    const c = await TestClient.connect(server, f, "viewer", "viewer");
    await waitFor(
      () => c.awareness.getStates().get(a.doc.clientID)?.name === "Ada",
      "presence for a late joiner",
    );

    a.close();
    await waitFor(() => !b.awareness.getStates().has(a.doc.clientID), "A's presence to be removed");
    await waitFor(
      () => !c.awareness.getStates().has(a.doc.clientID),
      "A's presence to be removed for C",
    );
  });

  it("rejects malformed messages and keeps serving", async () => {
    const server = await launch();
    const f = await createDocument();
    const a = await TestClient.connect(server, f, "owner", "owner");
    const b = await TestClient.connect(server, f, "editor", "editor");
    a.socket.emit("sync", "a string");
    a.socket.emit("sync", Uint8Array.from([9, 9, 9]));
    a.socket.emit("sync", Uint8Array.from([2, 200, 1, 1]));
    a.socket.emit("awareness", Uint8Array.from([255, 255, 255, 255]));
    a.socket.emit("awareness", { not: "binary" });
    await waitFor(() => a.rejected.length === 5, "five rejections");
    expect(a.rejected.every((r) => r.reason === "malformed")).toBe(true);
    a.insert(0, "still works");
    await waitFor(() => b.text === "still works", "the next update");
  });

  it("does not store an update that changes nothing", async () => {
    const server = await launch();
    const f = await createDocument();
    const a = await TestClient.connect(server, f, "owner", "owner");
    a.insert(0, "x");
    await waitFor(async () => (await updateRows(f.documentId)).length === 1, "one row");
    // Reconnect with everything the server already has: the handshake sends an empty step 2.
    const b = await TestClient.connect(server, f, "editor", "editor");
    b.forceSend(Y.encodeStateAsUpdate(b.doc));
    b.forceSendStep2();
    await settle();
    expect(await updateRows(f.documentId)).toHaveLength(1);
  });
});
