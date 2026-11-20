import { sealMembershipChange } from "@collabdocs/shared/redis-auth";
import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { encodeRelay } from "../src/relay";
import {
  REDIS_SECRET,
  TestClient,
  cleanup,
  closeDb,
  createDocument,
  launch,
  membershipChannel,
  publishRaw,
  relayChannel,
  resetDb,
  settle,
  waitFor,
} from "./support";

beforeEach(resetDb);
afterEach(cleanup);
afterAll(closeDb);

function insertion(text: string): Uint8Array {
  const doc = new Y.Doc();
  doc.getText("text").insert(0, text);
  return Y.encodeStateAsUpdate(doc);
}

describe("access to Redis alone cannot inject updates", () => {
  const frame = (documentId: string, secret: string, text: string) =>
    encodeRelay({ from: "intruder", documentId, kind: "update", data: insertion(text) }, secret);

  it("applies a relay frame signed with the secret and ignores one signed with another", async () => {
    const server = await launch({ redis: true });
    const f = await createDocument();
    const client = await TestClient.connect(server, f, "viewer", "viewer");

    await publishRaw(
      relayChannel(),
      frame(f.documentId, "an-attackers-guess-0123456789-abcdefghij", "forged"),
    );
    // A frame with no tag at all, and a frame that is only a body.
    await publishRaw(relayChannel(), frame(f.documentId, REDIS_SECRET, "x").subarray(0, 20));
    await settle(300);
    expect(client.text).toBe("");
    expect(
      server.logs.find(
        "ignored a relay frame that is malformed, stale or not signed with the secret",
      ).length,
    ).toBeGreaterThanOrEqual(2);

    // The same message with the right secret goes through, so the forgery failed on the tag alone.
    await publishRaw(relayChannel(), frame(f.documentId, REDIS_SECRET, "genuine"));
    await waitFor(() => client.text === "genuine", "the signed frame");
  });
});

describe("access to Redis alone cannot disconnect users", () => {
  const change = (documentId: string, userId: string) =>
    ({ documentId, userId, change: "removed" }) as const;

  it("ignores unsigned, wrongly signed and stale membership messages", async () => {
    const server = await launch({ redis: true });
    const f = await createDocument();
    const editor = await TestClient.connect(server, f, "editor", "editor");
    const message = change(f.documentId, f.users.editor!);

    await publishRaw(membershipChannel(), JSON.stringify(message));
    await publishRaw(
      membershipChannel(),
      sealMembershipChange(message, "an-attackers-guess-0123456789-abcdefghij"),
    );
    // A genuine message captured a few minutes ago and replayed.
    await publishRaw(
      membershipChannel(),
      sealMembershipChange(message, REDIS_SECRET, Date.now() - 10 * 60_000),
    );
    await settle(400);
    expect(editor.connected).toBe(true);
    expect(
      server.logs.find("ignored a membership message that is malformed, stale or not signed"),
    ).toHaveLength(3);

    await publishRaw(membershipChannel(), sealMembershipChange(message, REDIS_SECRET));
    await waitFor(() => !editor.connected, "the signed message to disconnect the editor");
  });
});
