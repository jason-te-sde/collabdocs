import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import {
  CollabTokenError,
  MAX_NAME_CHARS,
  MAX_TTL_SECONDS,
  signCollabToken,
  verifyCollabToken,
  type CollabTokenFailure,
} from "./token";

const SECRET = "0123456789abcdef0123456789abcdef-test-secret";
const OTHER_SECRET = "fedcba9876543210fedcba9876543210-other-secret";
const NOW = 1_800_000_000;
const claims = {
  documentId: "doc_1",
  userId: "user_1",
  role: "editor" as const,
  name: "Ada Lovelace",
};

async function reason(promise: Promise<unknown>): Promise<CollabTokenFailure | "no error"> {
  try {
    await promise;
    return "no error";
  } catch (error) {
    if (error instanceof CollabTokenError) return error.reason;
    throw error;
  }
}

describe("collaboration token", () => {
  it("round-trips the document, user, role and display name", async () => {
    const { token, expiresAt } = await signCollabToken({ ...claims, secret: SECRET, now: NOW });
    expect(expiresAt).toBe(NOW + 300);
    const verified = await verifyCollabToken({
      token,
      secret: SECRET,
      documentId: "doc_1",
      now: NOW + 1,
    });
    expect(verified).toEqual(claims);
  });

  it("expires after its lifetime", async () => {
    const { token, expiresAt } = await signCollabToken({
      ...claims,
      secret: SECRET,
      ttlSeconds: 60,
      now: NOW,
    });
    const ok = verifyCollabToken({
      token,
      secret: SECRET,
      documentId: "doc_1",
      now: expiresAt - 1,
    });
    await expect(ok).resolves.toBeDefined();
    const late = verifyCollabToken({ token, secret: SECRET, documentId: "doc_1", now: expiresAt });
    expect(await reason(late)).toBe("expired");
  });

  it("rejects a token for another document", async () => {
    const { token } = await signCollabToken({ ...claims, secret: SECRET, now: NOW });
    const result = verifyCollabToken({ token, secret: SECRET, documentId: "doc_2", now: NOW });
    expect(await reason(result)).toBe("wrong-document");
  });

  it("rejects a token signed with another secret", async () => {
    const { token } = await signCollabToken({ ...claims, secret: OTHER_SECRET, now: NOW });
    expect(
      await reason(verifyCollabToken({ token, secret: SECRET, documentId: "doc_1", now: NOW })),
    ).toBe("bad-signature");
  });

  it("rejects a tampered payload", async () => {
    const { token } = await signCollabToken({
      ...claims,
      role: "viewer",
      secret: SECRET,
      now: NOW,
    });
    const [header, payload, signature] = token.split(".") as [string, string, string];
    const decoded = JSON.parse(Buffer.from(payload, "base64url").toString()) as Record<
      string,
      unknown
    >;
    decoded.role = "owner";
    const forged = `${header}.${Buffer.from(JSON.stringify(decoded)).toString("base64url")}.${signature}`;
    expect(
      await reason(
        verifyCollabToken({ token: forged, secret: SECRET, documentId: "doc_1", now: NOW }),
      ),
    ).toBe("bad-signature");
  });

  it("rejects a tampered signature", async () => {
    const { token } = await signCollabToken({ ...claims, secret: SECRET, now: NOW });
    const flipped = token.slice(0, -2) + (token.endsWith("A") ? "BB" : "AA");
    const result = await reason(
      verifyCollabToken({ token: flipped, secret: SECRET, documentId: "doc_1", now: NOW }),
    );
    expect(["bad-signature", "malformed"]).toContain(result);
  });

  it("rejects an unsigned token", async () => {
    const header = Buffer.from(JSON.stringify({ alg: "none", typ: "JWT" })).toString("base64url");
    const body = Buffer.from(
      JSON.stringify({
        iss: "collabdocs-web",
        aud: "collabdocs-collab",
        sub: "user_1",
        doc: "doc_1",
        role: "owner",
        iat: NOW,
        exp: NOW + 300,
      }),
    ).toString("base64url");
    const result = verifyCollabToken({
      token: `${header}.${body}.`,
      secret: SECRET,
      documentId: "doc_1",
      now: NOW,
    });
    expect(await reason(result)).not.toBe("no error");
  });

  it("rejects garbage", async () => {
    expect(
      await reason(
        verifyCollabToken({ token: "not a token", secret: SECRET, documentId: "doc_1" }),
      ),
    ).toBe("malformed");
  });

  it("rejects a validly signed token with another audience or an unknown role", async () => {
    const key = new TextEncoder().encode(SECRET);
    const base = () =>
      new SignJWT({ doc: "doc_1", role: "editor", name: "Ada" })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("collabdocs-web")
        .setSubject("user_1")
        .setIssuedAt(NOW)
        .setExpirationTime(NOW + 300);
    const wrongAudience = await base().setAudience("someone-else").sign(key);
    expect(
      await reason(
        verifyCollabToken({ token: wrongAudience, secret: SECRET, documentId: "doc_1", now: NOW }),
      ),
    ).toBe("bad-claims");
    const badRole = await new SignJWT({ doc: "doc_1", role: "admin", name: "Ada" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("collabdocs-web")
      .setAudience("collabdocs-collab")
      .setSubject("user_1")
      .setIssuedAt(NOW)
      .setExpirationTime(NOW + 300)
      .sign(key);
    expect(
      await reason(
        verifyCollabToken({ token: badRole, secret: SECRET, documentId: "doc_1", now: NOW }),
      ),
    ).toBe("bad-claims");
  });

  it("cuts a long display name when signing and refuses an empty one", async () => {
    const long = "x".repeat(MAX_NAME_CHARS + 50);
    const { token } = await signCollabToken({ ...claims, name: long, secret: SECRET, now: NOW });
    const verified = await verifyCollabToken({
      token,
      secret: SECRET,
      documentId: "doc_1",
      now: NOW,
    });
    expect(verified.name).toBe("x".repeat(MAX_NAME_CHARS));
    await expect(signCollabToken({ ...claims, name: "  ", secret: SECRET })).rejects.toThrow(
      RangeError,
    );
  });

  it("rejects a validly signed token without a display name, or with one that is too long", async () => {
    const key = new TextEncoder().encode(SECRET);
    const make = (payload: Record<string, unknown>) =>
      new SignJWT({ doc: "doc_1", role: "editor", ...payload })
        .setProtectedHeader({ alg: "HS256" })
        .setIssuer("collabdocs-web")
        .setAudience("collabdocs-collab")
        .setSubject("user_1")
        .setIssuedAt(NOW)
        .setExpirationTime(NOW + 300)
        .sign(key);
    for (const payload of [
      {},
      { name: "" },
      { name: 7 },
      { name: "x".repeat(MAX_NAME_CHARS + 1) },
    ]) {
      const token = await make(payload);
      expect(
        await reason(verifyCollabToken({ token, secret: SECRET, documentId: "doc_1", now: NOW })),
      ).toBe("bad-claims");
    }
  });

  it("refuses a short secret and an excessive lifetime", async () => {
    await expect(signCollabToken({ ...claims, secret: "short" })).rejects.toThrow(
      /at least 32 bytes/,
    );
    await expect(
      signCollabToken({ ...claims, secret: SECRET, ttlSeconds: MAX_TTL_SECONDS + 1 }),
    ).rejects.toThrow(RangeError);
    await expect(signCollabToken({ ...claims, secret: SECRET, ttlSeconds: 0 })).rejects.toThrow(
      RangeError,
    );
  });
});
