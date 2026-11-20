import type { Role } from "@collabdocs/shared";
import { vi } from "vitest";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";

/** Makes the mocked Auth.js session belong to this user, or to nobody. */
export function signInAs(userId: string | null): void {
  const mocked = vi.mocked(auth) as unknown as { mockResolvedValue(value: unknown): void };
  mocked.mockResolvedValue(userId ? { user: { id: userId }, expires: "2999-01-01" } : null);
}

export async function createUser(name: string) {
  return getDb().user.create({ data: { email: `${name}@example.test`, name } });
}

export function jsonRequest(method: string, body?: unknown, headers: Record<string, string> = {}) {
  return new Request("http://localhost/test", {
    method,
    headers: { "content-type": "application/json", ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

export const ctx = <P extends Record<string, string>>(params: P) => ({
  params: Promise.resolve(params),
});

export interface Fixture {
  documentId: string;
  users: Record<
    "owner" | "editor" | "viewer" | "outsider" | "invitee" | "target",
    { id: string; email: string }
  >;
}

/**
 * One document with an owner, an editor and a viewer; a "target" member who is
 * a viewer (the one that role changes and removals act on); an "outsider" and
 * an "invitee", who are registered but not members.
 */
export async function fixture(): Promise<Fixture> {
  const db = getDb();
  const [owner, editor, viewer, outsider, invitee, target] = await Promise.all(
    ["owner", "editor", "viewer", "outsider", "invitee", "target"].map(createUser),
  );
  const members: Array<[{ id: string }, Role]> = [
    [editor!, "editor"],
    [viewer!, "viewer"],
    [target!, "viewer"],
  ];
  const document = await db.document.create({
    data: {
      title: "Plan",
      ownerId: owner!.id,
      memberships: {
        create: [
          { userId: owner!.id, role: "owner" },
          ...members.map(([user, role]) => ({ userId: user.id, role })),
        ],
      },
    },
  });
  return {
    documentId: document.id,
    users: {
      owner: owner!,
      editor: editor!,
      viewer: viewer!,
      outsider: outsider!,
      invitee: invitee!,
      target: target!,
    },
  };
}
