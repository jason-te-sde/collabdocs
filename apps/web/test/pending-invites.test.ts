import { afterEach, describe, expect, it, vi } from "vitest";
import { GET as getDocument } from "@/app/api/documents/[id]/route";
import { DELETE as withdraw } from "@/app/api/documents/[id]/invitations/[inviteId]/route";
import {
  DELETE as removeMember,
  PATCH as changeRole,
} from "@/app/api/documents/[id]/memberships/[userId]/route";
import { GET as listMembers, POST as invite } from "@/app/api/documents/[id]/memberships/route";
import { GET as listDocuments } from "@/app/api/documents/route";
import { POST as register } from "@/app/api/register/route";
import { POST as verify } from "@/app/api/verify-email/route";
import { getDb } from "@/lib/db";
import { sendVerificationEmail } from "@/lib/verification";
import {
  ctx,
  createUser,
  fixture,
  jsonRequest,
  mailTo,
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

afterEach(() => vi.restoreAllMocks());

const membershipOf = (f: Fixture, userId: string) =>
  getDb().membership.findUnique({
    where: { documentId_userId: { documentId: f.documentId, userId } },
  });

describe("an invitation is answered the same for every address", () => {
  it("gives the same status and body whether or not the address has an account", async () => {
    const f = await fixture();
    const unverified = await unverifiedInvitee(f);
    const answers = [];
    for (const email of [f.users.invitee.email, unverified.email, "nobody@example.test"]) {
      const response = await inviteAs(f, email, "viewer");
      const body = await response.json();
      answers.push({
        status: response.status,
        body: { invitation: { ...body.invitation, id: "-", email: "-" } },
        email: body.invitation.email,
        keys: Object.keys(body.invitation).sort(),
      });
    }
    expect(answers.map((a) => a.status)).toEqual([202, 202, 202]);
    expect(answers[0]!.body).toEqual(answers[1]!.body);
    expect(answers[1]!.body).toEqual(answers[2]!.body);
    expect(answers.map((a) => a.email)).toEqual([
      f.users.invitee.email,
      unverified.email,
      "nobody@example.test",
    ]);
  });

  it("answers the same for an address that is already a member", async () => {
    const f = await fixture();
    signInAs(f.users.owner.id);
    const response = await inviteAs(f, f.users.viewer.email, "editor");
    expect(response.status).toBe(202);
    expect(Object.keys((await response.json()).invitation).sort()).toEqual(["email", "id", "role"]);
    // Nothing changed: the member keeps their role, and no invitation is held.
    expect((await membershipOf(f, f.users.viewer.id))?.role).toBe("viewer");
    expect(await getDb().pendingInvite.count()).toBe(0);
  });

  it("holds the invitation and sends the details by email, to a registered or an unknown address", async () => {
    const f = await fixture();
    signInAs(f.users.owner.id);
    await inviteAs(f, f.users.invitee.email, "editor");
    await inviteAs(f, "newcomer@example.test", "viewer");
    expect(await getDb().pendingInvite.count()).toBe(2);
    const known = await mailTo(f.users.invitee.email);
    const unknown = await mailTo("newcomer@example.test");
    expect(known).toHaveLength(1);
    expect(unknown).toHaveLength(1);
    expect(known[0]!.text).toContain("Plan");
    expect(known[0]!.text).toContain("sign in");
    expect(unknown[0]!.text).toContain("create an account");
    // The message does not hold a verification token or any link that grants access.
    expect(known[0]!.text).not.toContain("token=");
  });

  it("is not changed by a mailer that fails", async () => {
    const f = await fixture();
    signInAs(f.users.owner.id);
    const transport = process.env.MAIL_TRANSPORT;
    process.env.MAIL_TRANSPORT = "no-such-transport";
    try {
      const response = await inviteAs(f, "nobody@example.test", "viewer");
      expect(response.status).toBe(202);
    } finally {
      process.env.MAIL_TRANSPORT = transport;
    }
    expect(await getDb().pendingInvite.count()).toBe(1);
  });

  it("keeps one invitation per document and address: inviting again changes the role", async () => {
    const f = await fixture();
    const stranger = await unverifiedInvitee(f);
    await inviteAs(f, stranger.email, "editor");
    expect((await inviteAs(f, stranger.email.toUpperCase(), "viewer")).status).toBe(202);
    const invites = await getDb().pendingInvite.findMany();
    expect(invites).toHaveLength(1);
    expect(invites[0]!.role).toBe("viewer");
  });

  it("lists pending invitations with the members, for every kind of address", async () => {
    const f = await fixture();
    const stranger = await unverifiedInvitee(f);
    await inviteAs(f, stranger.email, "viewer");
    await inviteAs(f, f.users.invitee.email, "editor");
    const listed = await (await listMembers(jsonRequest("GET"), ctx({ id: f.documentId }))).json();
    expect(listed.invitations.map((i: { email: string }) => i.email).sort()).toEqual(
      [stranger.email, f.users.invitee.email].sort(),
    );
    expect(listed.memberships.map((m: { email: string }) => m.email)).not.toContain(stranger.email);
  });
});

describe("an invitation becomes access when the address is verified and in use", () => {
  it("gives a verified account access the next time it opens the app, not before", async () => {
    const f = await fixture();
    signInAs(f.users.owner.id);
    await inviteAs(f, f.users.invitee.email, "editor");
    expect(await membershipOf(f, f.users.invitee.id)).toBeNull();

    // Opening the document: found by the invitation.
    expect(await canOpen(f, f.users.invitee.id)).toBe(true);
    expect((await membershipOf(f, f.users.invitee.id))?.role).toBe("editor");
    expect(await getDb().pendingInvite.count()).toBe(0);
  });

  it("binds when the account lists its documents", async () => {
    const f = await fixture();
    signInAs(f.users.owner.id);
    await inviteAs(f, f.users.invitee.email, "viewer");
    signInAs(f.users.invitee.id);
    const { documents } = await (await listDocuments()).json();
    expect(documents.map((d: { id: string }) => d.id)).toEqual([f.documentId]);
    expect(documents[0].role).toBe("viewer");
  });

  it("does not give an unverified account access", async () => {
    const f = await fixture();
    const stranger = await unverifiedInvitee(f);
    await inviteAs(f, stranger.email);
    expect(await canOpen(f, stranger.id)).toBe(false);
    signInAs(stranger.id);
    expect((await (await listDocuments()).json()).documents).toEqual([]);
    expect(await membershipOf(f, stranger.id)).toBeNull();
    expect(await getDb().pendingInvite.count()).toBe(1);
  });

  it("binds on verification, with the invited role, and then grants access", async () => {
    const f = await fixture();
    const stranger = await unverifiedInvitee(f);
    await inviteAs(f, stranger.email, "viewer");
    await verifyAddress(stranger.email);
    expect((await membershipOf(f, stranger.id))?.role).toBe("viewer");
    expect(await getDb().pendingInvite.count()).toBe(0);
    expect(await canOpen(f, stranger.id)).toBe(true);
  });

  it("holds the invitation for a person who registers later", async () => {
    const f = await fixture();
    signInAs(f.users.owner.id);
    await inviteAs(f, "later@example.test", "editor");
    await register(
      jsonRequest("POST", {
        email: "later@example.test",
        password: "correct horse battery staple",
      }),
    );
    const later = await getDb().user.findUniqueOrThrow({ where: { email: "later@example.test" } });
    expect(await canOpen(f, later.id)).toBe(false);
    await verifyAddress("later@example.test");
    expect(await canOpen(f, later.id)).toBe(true);
  });

  it("binds an invitation that was stored after the address had been verified", async () => {
    // The outcome of an invitation racing a verification: the row exists, the address is verified.
    const f = await fixture();
    const late = await createUser("late", false);
    await verifyAddress(late.email);
    await getDb().pendingInvite.create({
      data: {
        documentId: f.documentId,
        email: late.email,
        role: "editor",
        invitedById: f.users.owner.id,
      },
    });
    expect(await canOpen(f, late.id)).toBe(true);
    expect(await getDb().pendingInvite.count()).toBe(0);
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
    expect(await getDb().pendingInvite.count({ where: { email: bystander.email } })).toBe(1);
    expect(await getDb().membership.count({ where: { userId: bystander.id } })).toBe(0);
  });
});

describe("an invitation binds only while its inviter may still share", () => {
  async function invitedByEditor() {
    const f = await fixture();
    const stranger = await createUser("stranger", false);
    signInAs(f.users.editor.id);
    expect((await inviteAs(f, stranger.email, "editor")).status).toBe(202);
    return { f, stranger };
  }

  it("binds when the inviter is still an editor", async () => {
    const { f, stranger } = await invitedByEditor();
    await verifyAddress(stranger.email);
    expect((await membershipOf(f, stranger.id))?.role).toBe("editor");
  });

  it("drops and records the invitation of an inviter who was demoted to viewer", async () => {
    const { f, stranger } = await invitedByEditor();
    await getDb().membership.update({
      where: { documentId_userId: { documentId: f.documentId, userId: f.users.editor.id } },
      data: { role: "viewer" },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await verifyAddress(stranger.email);
    expect(await membershipOf(f, stranger.id)).toBeNull();
    expect(await getDb().pendingInvite.count()).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("dropped a pending invitation"),
      expect.objectContaining({ documentId: f.documentId, inviterId: f.users.editor.id }),
    );
  });

  it("drops the invitation of an inviter who is no longer a member, however they left", async () => {
    const { f, stranger } = await invitedByEditor();
    // Removed directly in the database, so that only the check at bind time can stop it.
    await getDb().membership.delete({
      where: { documentId_userId: { documentId: f.documentId, userId: f.users.editor.id } },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await verifyAddress(stranger.email);
    expect(await membershipOf(f, stranger.id)).toBeNull();
    expect(await getDb().pendingInvite.count()).toBe(0);
  });

  it("drops it at the time of a lazy bind too", async () => {
    const f = await fixture();
    signInAs(f.users.editor.id);
    await inviteAs(f, f.users.invitee.email, "editor");
    await getDb().membership.update({
      where: { documentId_userId: { documentId: f.documentId, userId: f.users.editor.id } },
      data: { role: "viewer" },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(await canOpen(f, f.users.invitee.id)).toBe(false);
    expect(await getDb().pendingInvite.count()).toBe(0);
  });

  it("deletes the invitations a member sent when they are removed or demoted through the routes", async () => {
    const f = await fixture();
    signInAs(f.users.editor.id);
    await inviteAs(f, "one@example.test", "viewer");
    signInAs(f.users.owner.id);
    await inviteAs(f, "two@example.test", "viewer");
    expect(await getDb().pendingInvite.count()).toBe(2);

    await changeRole(
      jsonRequest("PATCH", { role: "viewer" }),
      ctx({ id: f.documentId, userId: f.users.editor.id }),
    );
    expect((await getDb().pendingInvite.findMany()).map((i) => i.email)).toEqual([
      "two@example.test",
    ]);

    signInAs(f.users.owner.id);
    await changeRole(
      jsonRequest("PATCH", { role: "editor" }),
      ctx({ id: f.documentId, userId: f.users.viewer.id }),
    );
    signInAs(f.users.viewer.id);
    await inviteAs(f, "three@example.test", "viewer");
    signInAs(f.users.owner.id);
    await removeMember(jsonRequest("DELETE"), ctx({ id: f.documentId, userId: f.users.viewer.id }));
    expect((await getDb().pendingInvite.findMany()).map((i) => i.email)).toEqual([
      "two@example.test",
    ]);
  });
});

describe("withdrawing an invitation", () => {
  it("is done by the owner, after which verification grants nothing", async () => {
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

  it("is done only by someone who may change roles, and only within its document", async () => {
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
});

describe("the invite route is rate limited", () => {
  afterEach(() => {
    process.env.AUTH_LIMIT_INVITE_PER_USER = "1000";
    process.env.AUTH_LIMIT_INVITE_PER_ADDRESS = "1000";
  });

  it("per user, so that addresses cannot be probed without bound", async () => {
    process.env.AUTH_LIMIT_INVITE_PER_USER = "3";
    const f = await fixture();
    signInAs(f.users.owner.id);
    for (let n = 1; n <= 3; n += 1) {
      expect((await inviteAs(f, `probe${n}@example.test`)).status).toBe(202);
    }
    const refused = await inviteAs(f, "probe4@example.test");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(await getDb().pendingInvite.count()).toBe(3);
    // Another user has a budget of their own.
    signInAs(f.users.editor.id);
    expect((await inviteAs(f, "probe5@example.test")).status).toBe(202);
  });

  it("per address, so that one person's inbox cannot be flooded by many inviters", async () => {
    process.env.AUTH_LIMIT_INVITE_PER_ADDRESS = "2";
    const f = await fixture();
    for (const who of ["owner", "editor"] as const) {
      signInAs(f.users[who].id);
      expect((await inviteAs(f, "victim@example.test")).status).toBe(202);
    }
    signInAs(f.users.owner.id);
    expect((await inviteAs(f, "Victim@Example.Test")).status).toBe(429);
    expect(await mailTo("victim@example.test")).toHaveLength(2);
  });

  it("does not count a refused request, a viewer's or a stranger's", async () => {
    process.env.AUTH_LIMIT_INVITE_PER_USER = "1";
    const f = await fixture();
    signInAs(f.users.viewer.id);
    for (let n = 0; n < 3; n += 1) expect((await inviteAs(f, "x@example.test")).status).toBe(403);
    signInAs(f.users.outsider.id);
    expect((await inviteAs(f, "x@example.test")).status).toBe(404);
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
