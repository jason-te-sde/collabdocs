import { verifyCollabToken } from "@collabdocs/shared";
import { afterEach, describe, expect, it } from "vitest";
import { POST as issueToken } from "@/app/api/documents/[id]/collab-token/route";
import { collabTokenConfig } from "@/lib/collab-token";
import { ctx, fixture, jsonRequest, signInAs } from "./helpers";

const SECRET = process.env.COLLAB_TOKEN_SECRET!;
const issue = (id: string) => issueToken(jsonRequest("POST"), ctx({ id }));

describe("POST /documents/:id/collab-token", () => {
  afterEach(() => {
    process.env.COLLAB_TOKEN_SECRET = SECRET;
    delete process.env.COLLAB_TOKEN_TTL_SECONDS;
  });

  for (const [who, role] of [
    ["owner", "owner"],
    ["editor", "editor"],
    ["viewer", "viewer"],
  ] as const) {
    it(`gives a ${who} a token that carries role ${role}`, async () => {
      const f = await fixture();
      signInAs(f.users[who].id);
      const response = await issue(f.documentId);
      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body.role).toBe(role);
      const claims = await verifyCollabToken({
        token: body.token,
        secret: SECRET,
        documentId: f.documentId,
      });
      expect(claims).toEqual({ documentId: f.documentId, userId: f.users[who].id, role });
      const lifetime = body.expiresAt - Math.floor(Date.now() / 1000);
      expect(lifetime).toBeGreaterThan(290);
      expect(lifetime).toBeLessThanOrEqual(300);
    });
  }

  it("answers 404 to a non-member and 401 to nobody, and issues nothing", async () => {
    const f = await fixture();
    signInAs(f.users.outsider.id);
    const hidden = await issue(f.documentId);
    expect(hidden.status).toBe(404);
    expect(JSON.stringify(await hidden.json())).not.toContain("token");
    signInAs(null);
    expect((await issue(f.documentId)).status).toBe(401);
  });

  it("is not valid for another document", async () => {
    const f = await fixture();
    signInAs(f.users.owner.id);
    const { token } = await (await issue(f.documentId)).json();
    await expect(
      verifyCollabToken({ token, secret: SECRET, documentId: "other" }),
    ).rejects.toMatchObject({
      reason: "wrong-document",
    });
  });

  it("carries the role held now: a demoted member gets a new token with the new role", async () => {
    const f = await fixture();
    const { PATCH } = await import("@/app/api/documents/[id]/memberships/[userId]/route");
    signInAs(f.users.owner.id);
    await PATCH(
      jsonRequest("PATCH", { role: "editor" }),
      ctx({ id: f.documentId, userId: f.users.target.id }),
    );
    signInAs(f.users.target.id);
    expect((await (await issue(f.documentId)).json()).role).toBe("editor");
  });

  it("honours the configured lifetime", async () => {
    process.env.COLLAB_TOKEN_TTL_SECONDS = "60";
    const f = await fixture();
    signInAs(f.users.owner.id);
    const body = await (await issue(f.documentId)).json();
    expect(body.expiresAt - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(60);
  });

  it("answers 500 without leaking detail when the secret is missing", async () => {
    delete process.env.COLLAB_TOKEN_SECRET;
    const f = await fixture();
    signInAs(f.users.owner.id);
    const response = await issue(f.documentId);
    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain("COLLAB_TOKEN_SECRET");
  });
});

describe("collabTokenConfig", () => {
  const good = { COLLAB_TOKEN_SECRET: "x".repeat(32), AUTH_SECRET: "y".repeat(32) };

  it("accepts a strong, distinct secret and defaults to five minutes", () => {
    expect(collabTokenConfig(good)).toEqual({ secret: good.COLLAB_TOKEN_SECRET, ttlSeconds: 300 });
  });

  it("refuses a missing, short or reused secret and a bad lifetime", () => {
    expect(() => collabTokenConfig({})).toThrow(/at least 32 bytes/);
    expect(() => collabTokenConfig({ ...good, COLLAB_TOKEN_SECRET: "short" })).toThrow(
      /at least 32 bytes/,
    );
    expect(() => collabTokenConfig({ ...good, AUTH_SECRET: good.COLLAB_TOKEN_SECRET })).toThrow(
      /differ/,
    );
    for (const ttl of ["0", "901", "1.5", "abc"]) {
      expect(() => collabTokenConfig({ ...good, COLLAB_TOKEN_TTL_SECONDS: ttl })).toThrow(
        /integer/,
      );
    }
  });
});
