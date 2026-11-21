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

// `db:drift` compares the migrations with schema.prisma, and Prisma cannot express these
// objects, so a migration that dropped one would pass it. Read the catalog instead.
describe("the schema objects that Prisma cannot express exist", () => {
  const rows = <T>(query: string) => getDb().$queryRawUnsafe<T[]>(query);

  it("has the triggers, enabled, on the right tables and events", async () => {
    const triggers = await rows<{ name: string; enabled: string; def: string }>(
      `SELECT tgname AS name, tgenabled::text AS enabled, pg_get_triggerdef(oid) AS def
         FROM pg_trigger WHERE NOT tgisinternal`,
    );
    const byName = new Map(triggers.map((t) => [t.name, t]));
    const expected: Array<[string, RegExp]> = [
      // One owner per document, and the owner membership cannot be changed or removed.
      [
        "Membership_owner_guard",
        /BEFORE INSERT OR DELETE OR UPDATE ON public\."Membership" FOR EACH ROW/,
      ],
      // Every document has its owner membership by the end of its transaction.
      [
        "Document_requires_owner_membership",
        /CONSTRAINT TRIGGER.* AFTER INSERT ON public\."Document" DEFERRABLE INITIALLY DEFERRED FOR EACH ROW/,
      ],
      ["Document_owner_immutable", /BEFORE UPDATE ON public\."Document" FOR EACH ROW/],
      ["DocumentUpdate_append_only", /BEFORE UPDATE ON public\."DocumentUpdate" FOR EACH ROW/],
    ];
    for (const [name, definition] of expected) {
      const trigger = byName.get(name);
      expect(trigger, `trigger ${name}`).toBeDefined();
      expect(trigger!.enabled, `trigger ${name} is enabled`).toBe("O");
      expect(trigger!.def).toMatch(definition);
    }
  });

  it("has the partial unique index that allows one owner per document", async () => {
    const [index] = await rows<{ def: string }>(
      `SELECT indexdef AS def FROM pg_indexes WHERE indexname = 'Membership_one_owner_per_document'`,
    );
    expect(index, "index Membership_one_owner_per_document").toBeDefined();
    expect(index!.def).toMatch(/CREATE UNIQUE INDEX/);
    expect(index!.def).toMatch(/\("documentId"\)/);
    expect(index!.def).toMatch(/WHERE \(role = 'owner'::"Role"\)/);
  });

  it("has the CHECK constraints, including the title length", async () => {
    const checks = await rows<{ name: string; def: string }>(
      `SELECT conname AS name, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE contype = 'c'`,
    );
    const byName = new Map(checks.map((c) => [c.name, c.def]));
    expect(byName.get("Document_title_length")).toMatch(/char_length\(title\).*1.*200/);
    expect(byName.get("User_email_lowercase")).toMatch(/lower/);
    expect(byName.get("DocumentUpdate_seq_positive")).toMatch(/seq.*>= 1/);
    expect(byName.get("DocumentSnapshot_version_positive")).toMatch(/version.*>= 1/);
  });
});
