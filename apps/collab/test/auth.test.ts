import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  TestClient,
  cleanup,
  closeDb,
  connectErrorOf,
  createDocument,
  launch,
  mintToken,
  removeMember,
  resetDb,
  settle,
} from "./support";

beforeEach(resetDb);
afterEach(cleanup);
afterAll(closeDb);

describe("the handshake", () => {
  it("accepts a valid token for a member", async () => {
    const server = await launch();
    const f = await createDocument();
    const client = await TestClient.connect(server, f, "editor", "editor");
    expect(client.connected).toBe(true);
  });

  it("refuses an expired token", async () => {
    const server = await launch();
    const f = await createDocument();
    const token = await mintToken(f.documentId, f.users.editor!, "editor", {
      now: Math.floor(Date.now() / 1000) - 3600,
      ttlSeconds: 60,
    });
    const error = await connectErrorOf(server, f, "editor", "editor", { token });
    expect(error.code).toBe("invalid_token");
    expect(server.logs.find("handshake refused")[0]).toMatchObject({ code: "invalid_token" });
    expect(String(server.logs.find("handshake refused")[0]?.why)).toContain("expired");
  });

  it("refuses a token for another document", async () => {
    const server = await launch();
    const f = await createDocument();
    const other = await createDocument();
    const error = await connectErrorOf(server, f, "editor", "editor", {
      tokenDocumentId: other.documentId,
    });
    expect(error.code).toBe("invalid_token");
  });

  it("refuses a token signed with another secret", async () => {
    const server = await launch();
    const f = await createDocument();
    const token = await mintToken(f.documentId, f.users.editor!, "editor", {
      secret: "another-secret-that-is-long-enough-to-sign",
    });
    expect((await connectErrorOf(server, f, "editor", "editor", { token })).code).toBe(
      "invalid_token",
    );
  });

  it("refuses a connection with no token or a garbage token", async () => {
    const server = await launch();
    const f = await createDocument();
    expect(
      (await connectErrorOf(server, f, "editor", "editor", { token: "not.a.token" })).code,
    ).toBe("invalid_token");
    expect((await connectErrorOf(server, f, "editor", "editor", { token: "" })).code).toBe(
      "invalid_token",
    );
  });

  it("refuses a valid token whose membership no longer exists", async () => {
    const server = await launch();
    const f = await createDocument();
    const token = await mintToken(f.documentId, f.users.editor!, "editor");
    await removeMember(f.documentId, f.users.editor!);
    const error = await connectErrorOf(server, f, "editor", "editor", { token });
    expect(error.code).toBe("not_a_member");
  });

  it("does not load a document for a socket that failed the handshake", async () => {
    const server = await launch();
    const f = await createDocument();
    await connectErrorOf(server, f, "editor", "editor", { token: "bad" });
    await settle(100);
    expect(server.registry.size).toBe(0);
  });
});
