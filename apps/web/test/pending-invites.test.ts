import { describe, expect, it } from "vitest";
import { GET as getDocument } from "@/app/api/documents/[id]/route";
import { DELETE as withdraw } from "@/app/api/documents/[id]/invitations/[inviteId]/route";
import { GET as listMembers, POST as invite } from "@/app/api/documents/[id]/memberships/route";
import { POST as verify } from "@/app/api/verify-email/route";
import { getDb } from "@/lib/db";
import { sendVerificationEmail } from "@/lib/verification";
import {
  ctx,
  createUser,
  fixture,
  jsonRequest,
  signInAs,
  verificationTokenFor,
  type Fixture,
} from "./helpers";

async function unverifiedInvitee(f: Fixture, name = "stranger") {
  const user = await createUser(name, false);
  signInAs(f.users.owner.id);
  return user;
}

const inviteAs = (f: Fixture, email: string, role: "editor" | "viewer" = "editor") =>
  invite(jsonRequest("POST", { email, role }), ctx({ id: f.documentId }));

async function verifyAddress(email: string): Promise<void> {
  await sendVerificationEmail(email);
  const response = await verify(jsonRequest("POST", { token: await verificationTokenFor(email) }));
  expect(response.status).toBe(200);
}

const canOpen = async (f: Fixture, userId: string) => {
  signInAs(userId);
  return (await getDocument(jsonRequest("GET"), ctx({ id: f.documentId }))).status === 200;
};

describe("inviting an address that is not verified", () => {
  it("holds the invitation back: pending, with no access", async () => {
    const f = await fixture();
    const stranger = await unverifiedInvitee(f);
    const response = await inviteAs(f, stranger.email);
    expect(response.status).toBe(202);
    const { invitation } = await response.json();
    expect(invitation).toMatchObject({ email: stranger.email, role: "editor" });

    expect(
      await getDb().membership.count({ where: { documentId: f.documentId, userId: stranger.id } }),
    ).toBe(0);
    expect(await getDb().pendingInvite.count({ where: { documentId: f.documentId } })).toBe(1);
    expect(await canOpen(f, stranger.id)).toBe(false);
  });

  it("binds on verification, with the invited role, and then grants access", async () => {
    const f = await fixture();
    const stranger = await unverifiedInvitee(f);
    await inviteAs(f, stranger.email, "viewer");
    await verifyAddress(stranger.email);

    const membership = await getDb().membership.findUnique({
      where: { documentId_userId: { documentId: f.documentId, userId: stranger.id } },
    });
    expect(membership?.role).toBe("viewer");
    expect(await getDb().pendingInvite.count()).toBe(0);
    expect(await canOpen(f, stranger.id)).toBe(true);
  });

  it("binds every pending invitation to the address, and only that address", async () => {
    const f = await fixture();
    const g = await fixture("-g");
    const stranger = await unverifiedInvitee(f);
    const bystander = await createUser("bystander", false);
    await inviteAs(f, stranger.email, "editor");
    signInAs(g.users.owner.id);
    await inviteAs(g, stranger.email, "viewer");
    signInAs(f.users.owner.id);
    await inviteAs(f, bystander.email, "viewer");

    await verifyAddress(stranger.email);
    const roles = await getDb().membership.findMany({ where: { userId: stranger.id } });
    expect(roles.map((m) => [m.documentId, m.role]).sort()).toEqual(
      [
        [f.documentId, "editor"],
        [g.documentId, "viewer"],
      ].sort(),
    );
    // The other address's invitation is still held back.
    expect(await getDb().pendingInvite.count({ where: { email: bystander.email } })).toBe(1);
    expect(await getDb().membership.count({ where: { userId: bystander.id } })).toBe(0);
  });

  it("keeps one invitation per document and address: inviting again changes the role", async () => {
    const f = await fixture();
    const stranger = await unverifiedInvitee(f);
    await inviteAs(f, stranger.email, "editor");
    expect((await inviteAs(f, stranger.email, "viewer")).status).toBe(202);
    const invites = await getDb().pendingInvite.findMany();
    expect(invites).toHaveLength(1);
    expect(invites[0]!.role).toBe("viewer");
  });

  it("refuses to invite a member who has not verified, and an unknown address", async () => {
    const f = await fixture();
    signInAs(f.users.owner.id);
    await getDb().user.update({ where: { id: f.users.editor.id }, data: { emailVerified: null } });
    expect((await inviteAs(f, f.users.editor.email)).status).toBe(409);
    expect((await inviteAs(f, "nobody@example.test")).status).toBe(404);
  });

  it("is withdrawn by the owner, after which verification grants nothing", async () => {
    const f = await fixture();
    const stranger = await unverifiedInvitee(f);
    const { invitation } = await (await inviteAs(f, stranger.email)).json();
    const response = await withdraw(
      jsonRequest("DELETE"),
      ctx({ id: f.documentId, inviteId: invitation.id }),
    );
    expect(response.status).toBe(204);
    await verifyAddress(stranger.email);
    expect(await getDb().membership.count({ where: { userId: stranger.id } })).toBe(0);
  });

  it("is withdrawn only by someone who may change roles, and only within its document", async () => {
    const f = await fixture();
    const g = await fixture("-g");
    const stranger = await unverifiedInvitee(f);
    const { invitation } = await (await inviteAs(f, stranger.email)).json();
    const call = (id: string) =>
      withdraw(jsonRequest("DELETE"), ctx({ id, inviteId: invitation.id }));

    signInAs(null);
    expect((await call(f.documentId)).status).toBe(401);
    signInAs(f.users.outsider.id);
    expect((await call(f.documentId)).status).toBe(404);
    signInAs(f.users.editor.id);
    expect((await call(f.documentId)).status).toBe(403);
    signInAs(g.users.owner.id);
    expect((await call(g.documentId)).status).toBe(404);
    expect(await getDb().pendingInvite.count()).toBe(1);
    signInAs(f.users.owner.id);
    expect((await call(f.documentId)).status).toBe(204);
  });

  it("lists pending invitations with the members", async () => {
    const f = await fixture();
    const stranger = await unverifiedInvitee(f);
    await inviteAs(f, stranger.email, "viewer");
    const listed = await (await listMembers(jsonRequest("GET"), ctx({ id: f.documentId }))).json();
    expect(listed.invitations).toEqual([
      { id: expect.any(String), email: stranger.email, role: "viewer" },
    ]);
    expect(listed.memberships.map((m: { email: string }) => m.email)).not.toContain(stranger.email);
  });
});

describe("inviting an address that is verified", () => {
  it("still grants access at once", async () => {
    const f = await fixture();
    signInAs(f.users.owner.id);
    const response = await inviteAs(f, f.users.invitee.email, "editor");
    expect(response.status).toBe(201);
    expect(await canOpen(f, f.users.invitee.id)).toBe(true);
    expect(await getDb().pendingInvite.count()).toBe(0);
  });
});

describe("the database refuses what an invitation must never be", () => {
  it("rejects the owner role and an address that is not lower case", async () => {
    const f = await fixture();
    const data = {
      documentId: f.documentId,
      invitedById: f.users.owner.id,
      email: "who@example.test",
    };
    await expect(
      getDb().pendingInvite.create({ data: { ...data, role: "owner" } }),
    ).rejects.toThrow();
    await expect(
      getDb().pendingInvite.create({
        data: { ...data, email: "Who@Example.Test", role: "editor" },
      }),
    ).rejects.toThrow();
    await getDb().pendingInvite.create({ data: { ...data, role: "editor" } });
  });
});
