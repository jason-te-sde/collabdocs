import { describe, expect, it } from "vitest";
import {
  DELETE as deleteDocument,
  GET as getDocument,
  PATCH as renameDocument,
} from "@/app/api/documents/[id]/route";
import { GET as listDocuments, POST as createDocument } from "@/app/api/documents/route";
import { getDb } from "@/lib/db";
import { ctx, createUser, fixture, jsonRequest, signInAs } from "./helpers";

describe("create and list", () => {
  it("creates a document owned by the caller, with an owner membership", async () => {
    const user = await createUser("ada");
    signInAs(user.id);
    const response = await createDocument(jsonRequest("POST", { title: "  Notes  " }));
    expect(response.status).toBe(201);
    const { document } = await response.json();
    expect(document).toMatchObject({ title: "Notes", ownerId: user.id, role: "owner" });
    const membership = await getDb().membership.findFirstOrThrow({
      where: { documentId: document.id },
    });
    expect(membership).toMatchObject({ userId: user.id, role: "owner" });
  });

  it("refuses an empty title, a long title and a non-JSON body", async () => {
    const user = await createUser("ada");
    signInAs(user.id);
    expect((await createDocument(jsonRequest("POST", { title: "   " }))).status).toBe(400);
    expect((await createDocument(jsonRequest("POST", { title: "x".repeat(201) }))).status).toBe(
      400,
    );
    expect((await createDocument(jsonRequest("POST", { title: 5 }))).status).toBe(400);
    const text = new Request("http://localhost/test", { method: "POST", body: '{"title":"x"}' });
    expect((await createDocument(text)).status).toBe(415);
    const broken = new Request("http://localhost/test", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{",
    });
    expect((await createDocument(broken)).status).toBe(400);
  });

  it("lists only the documents the caller is a member of, with the caller's role", async () => {
    const f = await fixture();
    const other = await createUser("other");
    signInAs(other.id);
    await createDocument(jsonRequest("POST", { title: "Other's" }));

    signInAs(f.users.viewer.id);
    const { documents } = await (await listDocuments()).json();
    expect(documents).toHaveLength(1);
    expect(documents[0]).toMatchObject({ id: f.documentId, title: "Plan", role: "viewer" });

    signInAs(f.users.outsider.id);
    expect((await (await listDocuments()).json()).documents).toEqual([]);
  });
});

type Who = "owner" | "editor" | "viewer" | "outsider" | "anonymous";
const WHO: Who[] = ["owner", "editor", "viewer", "outsider", "anonymous"];

// Expected status per caller, in the order of WHO.
const TABLE: Array<[string, (id: string) => Promise<Response>, number[]]> = [
  [
    "GET /documents/:id",
    (id) => getDocument(jsonRequest("GET"), ctx({ id })),
    [200, 200, 200, 404, 401],
  ],
  [
    "PATCH /documents/:id",
    (id) => renameDocument(jsonRequest("PATCH", { title: "Renamed" }), ctx({ id })),
    [200, 200, 403, 404, 401],
  ],
  [
    "DELETE /documents/:id",
    (id) => deleteDocument(jsonRequest("DELETE"), ctx({ id })),
    [204, 403, 403, 404, 401],
  ],
];

describe("document routes by role", () => {
  for (const [name, call, expected] of TABLE) {
    WHO.forEach((who, index) => {
      it(`${name} as ${who} answers ${expected[index]}`, async () => {
        const f = await fixture();
        signInAs(who === "anonymous" ? null : f.users[who].id);
        const response = await call(f.documentId);
        expect(response.status).toBe(expected[index]);

        // A refused call changes nothing.
        const after = await getDb().document.findUnique({ where: { id: f.documentId } });
        const changed = expected[index] === 200 || expected[index] === 204;
        if (name.startsWith("DELETE")) expect(after === null).toBe(changed);
        if (name.startsWith("PATCH")) expect(after?.title).toBe(changed ? "Renamed" : "Plan");
      });
    });
  }

  it("answers a non-member the same as it answers a missing document", async () => {
    const f = await fixture();
    signInAs(f.users.outsider.id);
    const missing = await getDocument(jsonRequest("GET"), ctx({ id: "no-such-document" }));
    const hidden = await getDocument(jsonRequest("GET"), ctx({ id: f.documentId }));
    expect(hidden.status).toBe(404);
    expect(await hidden.json()).toEqual(await missing.json());
    for (const call of [
      () => renameDocument(jsonRequest("PATCH", { title: "x" }), ctx({ id: f.documentId })),
      () => deleteDocument(jsonRequest("DELETE"), ctx({ id: f.documentId })),
    ]) {
      expect((await call()).status).toBe(404);
    }
  });

  it("returns the caller's role on a document", async () => {
    const f = await fixture();
    signInAs(f.users.editor.id);
    const { document } = await (
      await getDocument(jsonRequest("GET"), ctx({ id: f.documentId }))
    ).json();
    expect(document).toMatchObject({ id: f.documentId, role: "editor" });
  });

  it("removes the document and its memberships when the owner deletes it", async () => {
    const f = await fixture();
    signInAs(f.users.owner.id);
    await deleteDocument(jsonRequest("DELETE"), ctx({ id: f.documentId }));
    expect(await getDb().membership.count()).toBe(0);
    signInAs(f.users.editor.id);
    expect((await getDocument(jsonRequest("GET"), ctx({ id: f.documentId }))).status).toBe(404);
  });

  it("validates the new title", async () => {
    const f = await fixture();
    signInAs(f.users.editor.id);
    const response = await renameDocument(
      jsonRequest("PATCH", { title: "" }),
      ctx({ id: f.documentId }),
    );
    expect(response.status).toBe(400);
  });
});
