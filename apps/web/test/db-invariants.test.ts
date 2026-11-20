import { describe, expect, it } from "vitest";
import { getDb } from "@/lib/db";
import { createUser, fixture } from "./helpers";

const db = () => getDb();

describe("database invariants", () => {
  it("allows one membership per user per document", async () => {
    const f = await fixture();
    await expect(
      db().membership.create({
        data: { documentId: f.documentId, userId: f.users.editor.id, role: "viewer" },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
  });

  it("allows one owner per document", async () => {
    const f = await fixture();
    await expect(
      db().membership.update({
        where: {
          documentId_userId: { documentId: f.documentId, userId: f.users.editor.id },
        },
        data: { role: "owner" },
      }),
    ).rejects.toThrow();
  });

  it("refuses an owner membership for a user who is not Document.ownerId", async () => {
    const f = await fixture();
    await db().membership.delete({
      where: { documentId_userId: { documentId: f.documentId, userId: f.users.target.id } },
    });
    await expect(
      db().membership.create({
        data: { documentId: f.documentId, userId: f.users.target.id, role: "owner" },
      }),
    ).rejects.toThrow();
  });

  it("refuses to demote or delete the owner membership", async () => {
    const f = await fixture();
    const where = { documentId_userId: { documentId: f.documentId, userId: f.users.owner.id } };
    await expect(db().membership.update({ where, data: { role: "editor" } })).rejects.toThrow(
      /cannot be changed or removed/,
    );
    await expect(db().membership.delete({ where })).rejects.toThrow(/cannot be changed or removed/);
  });

  it("refuses a document without an owner membership", async () => {
    const user = await createUser("lonely");
    await expect(
      db().document.create({ data: { title: "No owner membership", ownerId: user.id } }),
    ).rejects.toThrow(/owner membership/);
  });

  it("refuses to change the owner of a document", async () => {
    const f = await fixture();
    await expect(
      db().document.update({
        where: { id: f.documentId },
        data: { ownerId: f.users.editor.id },
      }),
    ).rejects.toThrow(/cannot be changed/);
  });

  it("deleting a document removes its memberships, snapshots and updates", async () => {
    const f = await fixture();
    await db().documentSnapshot.create({
      data: { documentId: f.documentId, version: 1, state: Buffer.from([1, 2, 3]) },
    });
    await db().documentUpdate.create({
      data: { documentId: f.documentId, seq: 1, data: Buffer.from([4]) },
    });
    await db().document.delete({ where: { id: f.documentId } });
    expect(await db().membership.count({ where: { documentId: f.documentId } })).toBe(0);
    expect(await db().documentSnapshot.count()).toBe(0);
    expect(await db().documentUpdate.count()).toBe(0);
  });

  it("refuses to delete a user who owns a document", async () => {
    const f = await fixture();
    await expect(db().user.delete({ where: { id: f.users.owner.id } })).rejects.toThrow();
  });

  it("keeps the update log append-only and its sequence unique", async () => {
    const f = await fixture();
    const row = await db().documentUpdate.create({
      data: { documentId: f.documentId, seq: 1, data: Buffer.from([1]) },
    });
    await expect(
      db().documentUpdate.create({
        data: { documentId: f.documentId, seq: 1, data: Buffer.from([2]) },
      }),
    ).rejects.toMatchObject({ code: "P2002" });
    await expect(
      db().documentUpdate.update({ where: { id: row.id }, data: { data: Buffer.from([9]) } }),
    ).rejects.toThrow(/append-only/);
    await expect(db().documentUpdate.delete({ where: { id: row.id } })).resolves.toBeDefined();
  });

  it("keeps one snapshot per document version, and versions start at 1", async () => {
    const f = await fixture();
    const data = { documentId: f.documentId, state: Buffer.from([1]) };
    await db().documentSnapshot.create({ data: { ...data, version: 1 } });
    await expect(
      db().documentSnapshot.create({ data: { ...data, version: 1 } }),
    ).rejects.toMatchObject({
      code: "P2002",
    });
    await expect(db().documentSnapshot.create({ data: { ...data, version: 0 } })).rejects.toThrow();
  });

  it("stores emails in lower case only", async () => {
    await expect(db().user.create({ data: { email: "Mixed@Example.Test" } })).rejects.toThrow();
    await db().user.create({ data: { email: "mixed@example.test" } });
    await expect(db().user.create({ data: { email: "mixed@example.test" } })).rejects.toMatchObject(
      {
        code: "P2002",
      },
    );
  });

  it("refuses an empty or oversized title", async () => {
    const f = await fixture();
    for (const title of ["", "x".repeat(201)]) {
      await expect(
        db().document.update({ where: { id: f.documentId }, data: { title } }),
      ).rejects.toThrow();
    }
  });
});
