import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import type { Role } from "@collabdocs/shared";
import { vi } from "vitest";
import { auth } from "@/auth";
import { getDb } from "@/lib/db";

/** Makes the mocked Auth.js session belong to this user, or to nobody. */
export function signInAs(userId: string | null): void {
  // The tests of the real Auth.js flow do not mock `auth`.
  if (!vi.isMockFunction(auth)) return;
  const mocked = vi.mocked(auth) as unknown as { mockResolvedValue(value: unknown): void };
  mocked.mockResolvedValue(userId ? { user: { id: userId }, expires: "2999-01-01" } : null);
}

/** A user whose email address is confirmed, unless `verified` is false. */
export async function createUser(name: string, verified = true, tag = "") {
  return getDb().user.create({
    data: {
      email: `${name}${tag}@example.test`,
      name,
      emailVerified: verified ? new Date() : null,
    },
  });
}

export interface SentMail {
  to: string;
  subject: string;
  text: string;
}

/** The messages the app has sent to this address since the test began, oldest first. */
export async function mailTo(email: string): Promise<SentMail[]> {
  const directory = process.env.MAIL_OUTBOX_DIR!;
  const names = (await readdir(directory).catch(() => [])).sort();
  const mails = await Promise.all(
    names.map(
      async (name) => JSON.parse(await readFile(path.join(directory, name), "utf8")) as SentMail,
    ),
  );
  return mails.filter((mail) => mail.to === email);
}

/** The verification token in the last mail to this address. */
export async function verificationTokenFor(email: string): Promise<string> {
  const last = (await mailTo(email)).at(-1);
  const token = last ? /verify-email\?token=([\w-]+)/.exec(last.text)?.[1] : undefined;
  if (!token) throw new Error(`no verification mail to ${email}`);
  return token;
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
export async function fixture(tag = ""): Promise<Fixture> {
  const db = getDb();
  const [owner, editor, viewer, outsider, invitee, target] = await Promise.all(
    ["owner", "editor", "viewer", "outsider", "invitee", "target"].map((name) =>
      createUser(name, true, tag),
    ),
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
