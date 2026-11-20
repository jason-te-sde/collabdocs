import { encodeMembershipChange } from "@collabdocs/shared";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TestClient,
  cleanup,
  closeDb,
  connectErrorOf,
  createDocument,
  launch,
  publishMembership,
  removeMember,
  resetDb,
  setRole,
  settle,
  waitFor,
} from "./support";

beforeEach(resetDb);
afterEach(cleanup);
afterAll(closeDb);

describe("membership changes", () => {
  it("disconnects a removed member and nobody else", async () => {
    const server = await launch({ redis: true });
    const f = await createDocument();
    const editor = await TestClient.connect(server, f, "editor", "editor");
    const viewer = await TestClient.connect(server, f, "viewer", "viewer");
    const owner = await TestClient.connect(server, f, "owner", "owner");
    // The same user on another document is unaffected.
    const g = await createDocument();
    const elsewhere = await TestClient.connect(server, g, "editor", "editor");

    await removeMember(f.documentId, f.users.editor!);
    await publishMembership(
      encodeMembershipChange({
        documentId: f.documentId,
        userId: f.users.editor!,
        change: "removed",
      }),
    );
    await waitFor(() => !editor.connected, "the removed member to be disconnected");
    expect(editor.revoked).toEqual([{ reason: "removed" }]);
    await settle(100);
    expect(viewer.connected && owner.connected && elsewhere.connected).toBe(true);

    // And cannot come back with the token they still hold.
    const refused = await connectErrorOf(server, f, "editor", "editor");
    expect(refused.code).toBe("not_a_member");
  });

  it("disconnects a member whose role changed, who reconnects with the new role", async () => {
    const server = await launch({ redis: true });
    const f = await createDocument();
    const editor = await TestClient.connect(server, f, "editor", "editor");
    await setRole(f.documentId, f.users.editor!, "viewer");
    await publishMembership(
      encodeMembershipChange({
        documentId: f.documentId,
        userId: f.users.editor!,
        change: "role-changed",
      }),
    );
    await waitFor(() => !editor.connected, "the demoted member to be disconnected");
    expect(editor.revoked).toEqual([{ reason: "role-changed" }]);

    // The old token still says editor; the membership says viewer, so writes are refused.
    const again = await TestClient.connect(server, f, "editor", "editor", { manual: true });
    again.insert(0, "no");
    again.forceSend((await import("yjs")).encodeStateAsUpdate(again.doc));
    await waitFor(() => again.rejected.length === 1, "a rejection after the demotion");
  });

  it("disconnects everyone when the document is deleted", async () => {
    const server = await launch({ redis: true });
    const f = await createDocument();
    const a = await TestClient.connect(server, f, "owner", "owner");
    const b = await TestClient.connect(server, f, "viewer", "viewer");
    await publishMembership(
      encodeMembershipChange({
        documentId: f.documentId,
        userId: null,
        change: "document-deleted",
      }),
    );
    await waitFor(() => !a.connected && !b.connected, "everyone to be disconnected");
  });

  it("ignores malformed messages on the channel", async () => {
    const server = await launch({ redis: true });
    const f = await createDocument();
    const a = await TestClient.connect(server, f, "owner", "owner");
    await publishMembership("garbage");
    await publishMembership(JSON.stringify({ documentId: f.documentId }));
    await waitFor(
      () =>
        server.logs.find("ignored a membership message that is malformed, stale or not signed")
          .length === 2,
      "two warnings",
    );
    expect(a.connected).toBe(true);
  });

  it("catches a change whose message was lost: the periodic re-check", async () => {
    const server = await launch({ persistence: { membershipRecheckMs: 100 } });
    const f = await createDocument();
    const editor = await TestClient.connect(server, f, "editor", "editor");
    const viewer = await TestClient.connect(server, f, "viewer", "viewer");
    await removeMember(f.documentId, f.users.editor!);
    await setRole(f.documentId, f.users.viewer!, "editor");
    await waitFor(() => !editor.connected, "the removed member to be disconnected");
    await waitFor(() => !viewer.connected, "the changed member to be disconnected");
    expect(editor.revoked).toEqual([{ reason: "removed" }]);
    expect(viewer.revoked).toEqual([{ reason: "role-changed" }]);
  });
});
