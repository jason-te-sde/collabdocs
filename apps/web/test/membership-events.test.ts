import {
  MEMBERSHIP_CHANNEL,
  parseMembershipChange,
  type MembershipChange,
} from "@collabdocs/shared";
import { Redis } from "ioredis";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DELETE as deleteDocument } from "@/app/api/documents/[id]/route";
import {
  DELETE as removeMember,
  PATCH as changeRole,
} from "@/app/api/documents/[id]/memberships/[userId]/route";
import { ctx, fixture, jsonRequest, signInAs } from "./helpers";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) throw new Error("REDIS_URL is not set; this test needs a Redis server");

let subscriber: Redis;
let received: MembershipChange[];

beforeEach(async () => {
  received = [];
  subscriber = new Redis(redisUrl);
  subscriber.on("message", (_channel, raw) => {
    const change = parseMembershipChange(raw);
    if (change) received.push(change);
  });
  await subscriber.subscribe(MEMBERSHIP_CHANNEL);
});

afterEach(() => {
  subscriber.disconnect();
});

async function waitForMessages(count: number): Promise<void> {
  for (let i = 0; i < 200 && received.length < count; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("membership change events", () => {
  it("publishes a role change", async () => {
    const f = await fixture();
    signInAs(f.users.owner.id);
    const response = await changeRole(
      jsonRequest("PATCH", { role: "editor" }),
      ctx({ id: f.documentId, userId: f.users.target.id }),
    );
    expect(response.status).toBe(200);
    await waitForMessages(1);
    expect(received).toEqual([
      { documentId: f.documentId, userId: f.users.target.id, change: "role-changed" },
    ]);
  });

  it("publishes a removal, whether the owner removes or the member leaves", async () => {
    const f = await fixture();
    signInAs(f.users.owner.id);
    await removeMember(jsonRequest("DELETE"), ctx({ id: f.documentId, userId: f.users.target.id }));
    signInAs(f.users.viewer.id);
    await removeMember(jsonRequest("DELETE"), ctx({ id: f.documentId, userId: f.users.viewer.id }));
    await waitForMessages(2);
    expect(received).toEqual([
      { documentId: f.documentId, userId: f.users.target.id, change: "removed" },
      { documentId: f.documentId, userId: f.users.viewer.id, change: "removed" },
    ]);
  });

  it("publishes a document deletion for every user of the document", async () => {
    const f = await fixture();
    signInAs(f.users.owner.id);
    await deleteDocument(jsonRequest("DELETE"), ctx({ id: f.documentId }));
    await waitForMessages(1);
    expect(received).toEqual([
      { documentId: f.documentId, userId: null, change: "document-deleted" },
    ]);
  });

  it("publishes nothing when the request is refused", async () => {
    const f = await fixture();
    signInAs(f.users.editor.id);
    const response = await changeRole(
      jsonRequest("PATCH", { role: "viewer" }),
      ctx({ id: f.documentId, userId: f.users.target.id }),
    );
    expect(response.status).toBe(403);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(received).toEqual([]);
  });
});
