import { describe, expect, it } from "vitest";
import { POST as register } from "@/app/api/register/route";
import { authenticate } from "@/lib/credentials";
import { getDb } from "@/lib/db";
import { GET as listDocuments, POST as createDocument } from "@/app/api/documents/route";
import { jsonRequest, mailTo } from "./helpers";

const PASSWORD = "correct horse battery staple";

async function signUp(email: string, password = PASSWORD, name?: string) {
  return register(jsonRequest("POST", { email, password, ...(name ? { name } : {}) }));
}

describe("registration", () => {
  it("creates a user with an argon2id hash and a lower-case email", async () => {
    const response = await signUp("Ada@Example.Test", PASSWORD, "Ada");
    expect(response.status).toBe(201);
    const { user } = await response.json();
    expect(user).toEqual({ email: "ada@example.test", name: "Ada" });
    const row = await getDb().user.findUniqueOrThrow({ where: { email: "ada@example.test" } });
    expect(row.passwordHash).toMatch(/^\$argon2id\$/);
    expect(row.passwordHash).not.toContain(PASSWORD);
  });

  it("does not return the hash", async () => {
    const body = await (await signUp("a@example.test")).json();
    expect(JSON.stringify(body)).not.toContain("argon2");
  });

  it("answers the same for an address that already has an account, and changes nothing", async () => {
    const first = await signUp("dup@example.test", PASSWORD, "First");
    const original = await getDb().user.findUniqueOrThrow({ where: { email: "dup@example.test" } });
    const again = await signUp("DUP@example.test", "another long password", "Second");
    expect(again.status).toBe(first.status);
    expect(await again.json()).toEqual({
      user: { email: "dup@example.test", name: "Second" },
      verification: "sent",
    });
    expect(await getDb().user.count()).toBe(1);
    const after = await getDb().user.findUniqueOrThrow({ where: { email: "dup@example.test" } });
    expect(after).toEqual(original);
    // The owner of the address is told by email, in words only they see.
    const mails = await mailTo("dup@example.test");
    expect(mails).toHaveLength(2);
    expect(mails[1]!.text).toContain("already have an account");
    expect(mails[1]!.text).not.toContain("token=");
  });

  it("answers the same when two registrations of one address race", async () => {
    const responses = await Promise.all([1, 2, 3, 4].map(() => signUp("race@example.test")));
    expect(responses.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(await getDb().user.count()).toBe(1);
  });

  it("refuses a short password, a bad email and a non-JSON body", async () => {
    expect((await signUp("short@example.test", "short")).status).toBe(400);
    expect((await signUp("not-an-email")).status).toBe(400);
    const form = new Request("http://localhost/test", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: "email=a%40example.test&password=0123456789abc",
    });
    expect((await register(form)).status).toBe(415);
  });
});

describe("credentials sign-in", () => {
  it("accepts the right password, whatever the case of the email", async () => {
    await signUp("ada@example.test");
    const user = await authenticate({ email: "ADA@example.test", password: PASSWORD });
    expect(user?.email).toBe("ada@example.test");
  });

  it("refuses a wrong password, an unknown email and malformed input", async () => {
    await signUp("ada@example.test");
    expect(
      await authenticate({ email: "ada@example.test", password: "wrong password!" }),
    ).toBeNull();
    expect(await authenticate({ email: "nobody@example.test", password: PASSWORD })).toBeNull();
    expect(await authenticate({ email: "ada@example.test" })).toBeNull();
    expect(await authenticate(null)).toBeNull();
    expect(
      await authenticate({ email: "ada@example.test", password: "x".repeat(10_000) }),
    ).toBeNull();
  });

  it("refuses a user who has no password (a GitHub-only user)", async () => {
    await getDb().user.create({ data: { email: "gh@example.test" } });
    expect(await authenticate({ email: "gh@example.test", password: PASSWORD })).toBeNull();
    expect(await authenticate({ email: "gh@example.test", password: "" })).toBeNull();
  });
});

describe("a route without a session", () => {
  it("answers 401, and also 401 for a user who no longer exists", async () => {
    expect((await listDocuments()).status).toBe(401);
    expect((await createDocument(jsonRequest("POST", { title: "x" }))).status).toBe(401);
    const { signInAs } = await import("./helpers");
    signInAs("a-user-id-that-does-not-exist");
    expect((await listDocuments()).status).toBe(401);
  });
});
