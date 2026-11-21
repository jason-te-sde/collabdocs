import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CollabServer } from "../src/index";
import {
  TestClient,
  cleanup,
  closeDb,
  createDocument,
  launch,
  removeMember,
  resetDb,
  setRole,
  settle,
  updateRows,
  waitFor,
} from "./support";

beforeEach(resetDb);
afterEach(cleanup);
afterAll(closeDb);

/** Counts calls of store.role; `after` replaces the answer from the nth call on. */
function spyOnRole(
  server: CollabServer,
  after?: { call: number; answer: () => Promise<null> },
): { calls: () => number } {
  const real = server.store.role.bind(server.store);
  let calls = 0;
  server.store.role = (documentId, userId) => {
    calls += 1;
    if (after && calls >= after.call) return after.answer();
    return real(documentId, userId);
  };
  return { calls: () => calls };
}

describe("a revoked member cannot write", () => {
  it("is caught when the socket finishes attaching, if the membership went during the load", async () => {
    const server = await launch();
    const f = await createDocument();
    // The handshake (call 1) still sees the membership; by the time the load is done it is gone.
    spyOnRole(server, { call: 2, answer: async () => null });
    const client = await TestClient.connect(server, f, "editor", "editor", { noWait: true });
    await waitFor(() => client.revoked.length === 1, "the revocation");
    expect(client.revoked[0]).toEqual({ reason: "removed" });
    await waitFor(() => !client.connected, "the socket to close");
    expect(client.synced).toBe(false);
    expect(server.registry.get(f.documentId)?.sockets.size ?? 0).toBe(0);
  });

  it("is caught on the next write after a removal, without waiting for the periodic re-check", async () => {
    const server = await launch({
      persistence: { roleCacheMs: 100, membershipRecheckMs: 600_000 },
    });
    const f = await createDocument();
    const editor = await TestClient.connect(server, f, "editor", "editor");
    editor.insert(0, "allowed");
    await waitFor(async () => (await updateRows(f.documentId)).length === 1, "the first write");

    await removeMember(f.documentId, f.users.editor!);
    await settle(150);
    editor.append(" refused");
    await waitFor(() => editor.revoked.length === 1, "the revocation");
    expect(editor.revoked[0]).toEqual({ reason: "removed" });
    await waitFor(() => !editor.connected, "the socket to close");
    await settle(150);
    expect(await updateRows(f.documentId)).toHaveLength(1);
  });

  it("is caught on the next write after a demotion", async () => {
    const server = await launch({
      persistence: { roleCacheMs: 100, membershipRecheckMs: 600_000 },
    });
    const f = await createDocument();
    const editor = await TestClient.connect(server, f, "editor", "editor");
    await setRole(f.documentId, f.users.editor!, "viewer");
    await settle(150);
    editor.insert(0, "refused");
    await waitFor(() => editor.revoked.length === 1, "the revocation");
    expect(editor.revoked[0]).toEqual({ reason: "role-changed" });
    await settle(150);
    expect(await updateRows(f.documentId)).toHaveLength(0);
  });

  it("reads the role at most once per cache period, however fast the socket writes", async () => {
    const server = await launch({ persistence: { roleCacheMs: 600 } });
    const f = await createDocument();
    const editor = await TestClient.connect(server, f, "editor", "editor");
    const spy = spyOnRole(server);
    for (let i = 0; i < 30; i += 1) editor.append("x");
    await waitFor(async () => (await updateRows(f.documentId)).length > 0, "the writes");
    await settle(200);
    expect(spy.calls()).toBe(0);
    await settle(500);
    editor.append("y");
    await settle(200);
    editor.append("z");
    await waitFor(async () => (await updateRows(f.documentId)).length > 0, "more writes");
    await settle(300);
    expect(spy.calls()).toBe(1);
  });
});

describe("the periodic re-check fails closed", () => {
  it("disconnects the sockets when the database keeps failing, not after one failure", async () => {
    const server = await launch({ persistence: { membershipRecheckMs: 50 } });
    const f = await createDocument();
    const a = await TestClient.connect(server, f, "owner", "owner");
    const b = await TestClient.connect(server, f, "viewer", "viewer");
    const real = server.store.roles.bind(server.store);
    let calls = 0;
    // Two failures, a success, two failures, a success, and so on: never three in a row.
    server.store.roles = (documentId) =>
      ++calls % 3 === 0 ? real(documentId) : Promise.reject(new Error("database down"));
    await settle(600);
    expect(calls).toBeGreaterThanOrEqual(6);
    expect(a.connected && b.connected).toBe(true);

    server.store.roles = () => Promise.reject(new Error("database down"));
    await waitFor(() => !a.connected && !b.connected, "the sockets to be disconnected");
    expect(
      server.logs.find("memberships cannot be verified; disconnecting the sockets"),
    ).toHaveLength(1);
  });
});
