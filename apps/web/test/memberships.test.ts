import { describe, expect, it } from "vitest";
import { GET as listMembers, POST as invite } from "@/app/api/documents/[id]/memberships/route";
import {
  DELETE as removeMember,
  PATCH as changeRole,
} from "@/app/api/documents/[id]/memberships/[userId]/route";
import { getDb } from "@/lib/db";
import { ctx, fixture, jsonRequest, signInAs, type Fixture } from "./helpers";

type Who = "owner" | "editor" | "viewer" | "outsider" | "anonymous";
const WHO: Who[] = ["owner", "editor", "viewer", "outsider", "anonymous"];

const roleOf = async (f: Fixture, user: keyof Fixture["users"]) =>
  (
    await getDb().membership.findUnique({
      where: { documentId_userId: { documentId: f.documentId, userId: f.users[user].id } },
    })
  )?.role ?? null;

const TABLE: Array<[string, (f: Fixture) => Promise<Response>, number[]]> = [
  [
    "GET memberships",
    (f) => listMembers(jsonRequest("GET"), ctx({ id: f.documentId })),
    [200, 200, 200, 404, 401],
  ],
  [
    "POST memberships (invite)",
    (f) =>
      invite(
        jsonRequest("POST", { email: f.users.invitee.email, role: "viewer" }),
        ctx({ id: f.documentId }),
      ),
    [201, 201, 403, 404, 401],
  ],
  [
    "PATCH memberships/:userId (change role)",
    (f) =>
      changeRole(
        jsonRequest("PATCH", { role: "editor" }),
        ctx({ id: f.documentId, userId: f.users.target.id }),
      ),
    [200, 403, 403, 404, 401],
  ],
  [
    "DELETE memberships/:userId (remove another)",
    (f) =>
      removeMember(jsonRequest("DELETE"), ctx({ id: f.documentId, userId: f.users.target.id })),
    [204, 403, 403, 404, 401],
  ],
];

describe("membership routes by role", () => {
  for (const [name, call, expected] of TABLE) {
    WHO.forEach((who, index) => {
      it(`${name} as ${who} answers ${expected[index]}`, async () => {
        const f = await fixture();
        signInAs(who === "anonymous" ? null : f.users[who].id);
        const response = await call(f);
        expect(response.status).toBe(expected[index]);

        const ok = expected[index] === 200 || expected[index] === 201 || expected[index] === 204;
        if (name.startsWith("POST")) expect(await roleOf(f, "invitee")).toBe(ok ? "viewer" : null);
        if (name.startsWith("PATCH"))
          expect(await roleOf(f, "target")).toBe(ok ? "editor" : "viewer");
        if (name.startsWith("DELETE")) expect(await roleOf(f, "target")).toBe(ok ? null : "viewer");
      });
    });
  }
});

describe("inviting", () => {
  it("lets an editor invite, but never as owner", async () => {
    const f = await fixture();
    signInAs(f.users.editor.id);
    const asOwner = await invite(
      jsonRequest("POST", { email: f.users.invitee.email, role: "owner" }),
      ctx({ id: f.documentId }),
    );
    expect(asOwner.status).toBe(400);
    expect(await roleOf(f, "invitee")).toBeNull();
    const asEditor = await invite(
      jsonRequest("POST", { email: f.users.invitee.email.toUpperCase(), role: "editor" }),
      ctx({ id: f.documentId }),
    );
    expect(asEditor.status).toBe(201);
    expect(await roleOf(f, "invitee")).toBe("editor");
  });

  it("answers 409 for a member who is already in, 404 for an unknown email", async () => {
    const f = await fixture();
    signInAs(f.users.owner.id);
    const again = await invite(
      jsonRequest("POST", { email: f.users.viewer.email, role: "editor" }),
      ctx({ id: f.documentId }),
    );
    expect(again.status).toBe(409);
    expect(await roleOf(f, "viewer")).toBe("viewer");
    const unknown = await invite(
      jsonRequest("POST", { email: "nobody@example.test", role: "viewer" }),
      ctx({ id: f.documentId }),
    );
    expect(unknown.status).toBe(404);
  });

  it("does not let a viewer or outsider probe which emails are registered", async () => {
    const f = await fixture();
    for (const who of ["viewer", "outsider"] as const) {
      signInAs(f.users[who].id);
      const response = await invite(
        jsonRequest("POST", { email: "nobody@example.test", role: "viewer" }),
        ctx({ id: f.documentId }),
      );
      expect(response.status).toBe(who === "viewer" ? 403 : 404);
    }
  });
});

describe("changing roles and removing", () => {
  it("never changes or removes the owner, even for the owner", async () => {
    const f = await fixture();
    signInAs(f.users.owner.id);
    const params = ctx({ id: f.documentId, userId: f.users.owner.id });
    expect((await changeRole(jsonRequest("PATCH", { role: "viewer" }), params)).status).toBe(409);
    expect((await removeMember(jsonRequest("DELETE"), params)).status).toBe(409);
    expect(await roleOf(f, "owner")).toBe("owner");
  });

  it("refuses to make anyone an owner", async () => {
    const f = await fixture();
    signInAs(f.users.owner.id);
    const response = await changeRole(
      jsonRequest("PATCH", { role: "owner" }),
      ctx({ id: f.documentId, userId: f.users.target.id }),
    );
    expect(response.status).toBe(400);
    expect(await roleOf(f, "target")).toBe("viewer");
  });

  it("answers 404 for a user who is not a member", async () => {
    const f = await fixture();
    signInAs(f.users.owner.id);
    const params = ctx({ id: f.documentId, userId: f.users.outsider.id });
    expect((await changeRole(jsonRequest("PATCH", { role: "viewer" }), params)).status).toBe(404);
    expect((await removeMember(jsonRequest("DELETE"), params)).status).toBe(404);
  });

  it("lets an editor or viewer leave, and a viewer cannot remove an editor", async () => {
    const f = await fixture();
    signInAs(f.users.viewer.id);
    const removeEditor = ctx({ id: f.documentId, userId: f.users.editor.id });
    expect((await removeMember(jsonRequest("DELETE"), removeEditor)).status).toBe(403);
    const leave = (who: "viewer" | "editor") =>
      removeMember(jsonRequest("DELETE"), ctx({ id: f.documentId, userId: f.users[who].id }));
    expect((await leave("viewer")).status).toBe(204);
    expect(await roleOf(f, "viewer")).toBeNull();
    signInAs(f.users.editor.id);
    expect((await leave("editor")).status).toBe(204);
  });

  it("a removed member can no longer see the document", async () => {
    const f = await fixture();
    signInAs(f.users.owner.id);
    await removeMember(jsonRequest("DELETE"), ctx({ id: f.documentId, userId: f.users.editor.id }));
    signInAs(f.users.editor.id);
    const { GET } = await import("@/app/api/documents/[id]/route");
    expect((await GET(jsonRequest("GET"), ctx({ id: f.documentId }))).status).toBe(404);
  });

  it("lists members with their roles and no password hash", async () => {
    const f = await fixture();
    signInAs(f.users.viewer.id);
    const text = await (await listMembers(jsonRequest("GET"), ctx({ id: f.documentId }))).text();
    const { memberships } = JSON.parse(text);
    expect(memberships.map((m: { role: string }) => m.role).sort()).toEqual([
      "editor",
      "owner",
      "viewer",
      "viewer",
    ]);
    expect(text).not.toContain("passwordHash");
  });
});
