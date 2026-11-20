import { createHash } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { POST as register } from "@/app/api/register/route";
import { POST as resend } from "@/app/api/verify-email/resend/route";
import { POST as verify } from "@/app/api/verify-email/route";
import { getDb } from "@/lib/db";
import { createMailer } from "@/lib/mailer";
import { sendVerificationEmail, VERIFICATION_TTL_MS } from "@/lib/verification";
import { createUser, jsonRequest, mailTo, signInAs, verificationTokenFor } from "./helpers";

const PASSWORD = "correct horse battery staple";

const signUp = (email: string) => register(jsonRequest("POST", { email, password: PASSWORD }));
const confirm = (token: string) => verify(jsonRequest("POST", { token }));
const emailVerified = async (email: string) =>
  (await getDb().user.findUniqueOrThrow({ where: { email } })).emailVerified;

describe("email verification", () => {
  it("emails a link to a new account, which stays unverified until the link is used", async () => {
    const response = await signUp("Ada@Example.Test");
    expect(response.status).toBe(201);
    expect((await response.json()).verification).toBe("sent");

    const mails = await mailTo("ada@example.test");
    expect(mails).toHaveLength(1);
    expect(mails[0]!.text).toContain("/verify-email?token=");
    expect(await emailVerified("ada@example.test")).toBeNull();

    const token = await verificationTokenFor("ada@example.test");
    const confirmed = await confirm(token);
    expect(confirmed.status).toBe(200);
    expect(await confirmed.json()).toEqual({ verified: true, email: "ada@example.test" });
    expect(await emailVerified("ada@example.test")).toBeInstanceOf(Date);
  });

  it("stores only a hash of the token", async () => {
    await signUp("hash@example.test");
    const token = await verificationTokenFor("hash@example.test");
    const rows = await getDb().verificationToken.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.token).not.toBe(token);
    expect(rows[0]!.token).toBe(createHash("sha256").update(token).digest("hex"));
    expect(rows[0]!.identifier).toBe("hash@example.test");
  });

  it("works once", async () => {
    await signUp("once@example.test");
    const token = await verificationTokenFor("once@example.test");
    expect((await confirm(token)).status).toBe(200);
    const again = await confirm(token);
    expect(again.status).toBe(400);
    expect((await again.json()).error.code).toBe("invalid_token");
  });

  it("refuses an expired token, an unknown one and one that was altered", async () => {
    await createUser("late", false);
    const token = await sendVerificationEmail(
      "late@example.test",
      Date.now() - VERIFICATION_TTL_MS - 1000,
    );
    expect((await confirm(token)).status).toBe(400);
    expect(await emailVerified("late@example.test")).toBeNull();

    const fresh = await sendVerificationEmail("late@example.test");
    expect((await confirm(`${fresh.slice(0, -1)}${fresh.endsWith("A") ? "B" : "A"}`)).status).toBe(
      400,
    );
    expect((await confirm("x".repeat(43))).status).toBe(400);
    expect(await emailVerified("late@example.test")).toBeNull();
    expect((await confirm(fresh)).status).toBe(200);
  });

  it("verifies the address the token was issued for, not another account's", async () => {
    await signUp("one@example.test");
    await signUp("two@example.test");
    await confirm(await verificationTokenFor("one@example.test"));
    expect(await emailVerified("one@example.test")).toBeInstanceOf(Date);
    expect(await emailVerified("two@example.test")).toBeNull();
  });

  it("registration succeeds when the mail cannot be sent, and says so", async () => {
    const transport = process.env.MAIL_TRANSPORT;
    process.env.MAIL_TRANSPORT = "no-such-transport";
    try {
      const response = await signUp("nomail@example.test");
      expect(response.status).toBe(201);
      expect((await response.json()).verification).toBe("failed");
      expect(await getDb().user.count({ where: { email: "nomail@example.test" } })).toBe(1);
    } finally {
      process.env.MAIL_TRANSPORT = transport;
    }
  });
});

describe("sending the link again", () => {
  it("replaces the earlier link", async () => {
    await signUp("again@example.test");
    const first = await verificationTokenFor("again@example.test");
    const user = await getDb().user.findUniqueOrThrow({ where: { email: "again@example.test" } });
    signInAs(user.id);
    expect((await resend(jsonRequest("POST", {}))).status).toBe(200);
    const second = await verificationTokenFor("again@example.test");
    expect(second).not.toBe(first);
    expect((await mailTo("again@example.test")).length).toBe(2);
    expect((await confirm(first)).status).toBe(400);
    expect((await confirm(second)).status).toBe(200);
  });

  it("needs a session, and does nothing for a verified account", async () => {
    expect((await resend(jsonRequest("POST", {}))).status).toBe(401);
    const user = await createUser("done");
    signInAs(user.id);
    const response = await resend(jsonRequest("POST", {}));
    expect(await response.json()).toEqual({ alreadyVerified: true });
    expect(await mailTo("done@example.test")).toHaveLength(0);
  });
});

describe("the mailer", () => {
  it("writes files for the file transport", async () => {
    await createMailer({
      MAIL_TRANSPORT: "file",
      MAIL_OUTBOX_DIR: process.env.MAIL_OUTBOX_DIR,
    }).send({ to: "x@example.test", subject: "s", text: "t" });
    expect(await mailTo("x@example.test")).toEqual([
      { to: "x@example.test", subject: "s", text: "t" },
    ]);
  });

  it("defaults to the console in development and refuses to guess in production", () => {
    expect(() => createMailer({ NODE_ENV: "development" })).not.toThrow();
    expect(() => createMailer({ NODE_ENV: "production" })).toThrow(/MAIL_TRANSPORT/);
    expect(() => createMailer({ MAIL_TRANSPORT: "carrier-pigeon" })).toThrow(/unknown/);
    expect(() => createMailer({ MAIL_TRANSPORT: "file" })).toThrow(/MAIL_OUTBOX_DIR/);
  });
});

afterEach(() => signInAs(null));
