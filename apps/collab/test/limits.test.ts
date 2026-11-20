import { afterAll, afterEach, beforeEach, describe, expect, it } from "vitest";
import { RateLimiter } from "../src/limits";
import {
  TestClient,
  cleanup,
  closeDb,
  connectErrorOf,
  createDocument,
  launch,
  resetDb,
  settle,
  storedText,
  updateRows,
  waitFor,
} from "./support";

beforeEach(resetDb);
afterEach(cleanup);
afterAll(closeDb);

describe("RateLimiter", () => {
  it("allows a burst, then the sustained rate", () => {
    let now = 0;
    const limiter = new RateLimiter(10, 5, () => now);
    expect(Array.from({ length: 6 }, () => limiter.allow())).toEqual([
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    now += 100; // one token comes back
    expect(limiter.allow()).toBe(true);
    expect(limiter.allow()).toBe(false);
    now += 10_000; // never more than the burst
    expect(Array.from({ length: 6 }, () => limiter.allow()).filter(Boolean)).toHaveLength(5);
  });
});

describe("limits", () => {
  it("rejects an update over the size limit and leaves the state alone", async () => {
    const server = await launch({ limits: { maxUpdateBytes: 2000 } });
    const f = await createDocument();
    const a = await TestClient.connect(server, f, "owner", "owner");
    const b = await TestClient.connect(server, f, "editor", "editor");
    a.insert(0, "small");
    await waitFor(() => b.text === "small", "the small update");

    // Just over the limit but inside the transport's frame allowance: refused by the server.
    a.append("x".repeat(2100));
    await waitFor(() => a.rejected.length === 1, "a rejection");
    expect(a.rejected[0]).toEqual({ event: "sync", reason: "too_large" });
    expect(server.logs.find("message rejected")[0]).toMatchObject({ reason: "too_large" });
    await settle();
    expect(b.text).toBe("small");
    expect(await storedText(f.documentId)).toBe("small");
    expect(await updateRows(f.documentId)).toHaveLength(1);
    expect(a.connected).toBe(true);
  });

  it("closes a connection that sends a frame far over the limit", async () => {
    const server = await launch({ limits: { maxUpdateBytes: 2000 } });
    const f = await createDocument();
    const a = await TestClient.connect(server, f, "owner", "owner");
    const b = await TestClient.connect(server, f, "editor", "editor");
    a.append("y".repeat(20_000));
    await waitFor(() => !a.connected, "the connection to be closed");
    await settle();
    expect(b.text).toBe("");
    expect(await updateRows(f.documentId)).toHaveLength(0);
  });

  it("applies the size limit to awareness updates too", async () => {
    const server = await launch({ limits: { maxUpdateBytes: 2000 } });
    const f = await createDocument();
    const a = await TestClient.connect(server, f, "owner", "owner");
    const b = await TestClient.connect(server, f, "editor", "editor");
    a.awareness.setLocalState({ blob: "z".repeat(2100) });
    await waitFor(() => a.rejected.length === 1, "a rejection");
    expect(a.rejected[0]).toEqual({ event: "awareness", reason: "too_large" });
    await settle();
    expect(b.awareness.getStates().size).toBe(0);
  });

  it("disconnects a socket that sends messages faster than the rate limit", async () => {
    const server = await launch({ limits: { maxMessagesPerSecond: 5, messageBurst: 10 } });
    const f = await createDocument();
    const flooder = await TestClient.connect(server, f, "owner", "owner");
    const other = await TestClient.connect(server, f, "editor", "editor");
    for (let i = 0; i < 50; i += 1) flooder.awareness.setLocalState({ i });
    await waitFor(() => !flooder.connected, "the flooder to be disconnected");
    expect(server.logs.find("rate limit exceeded; disconnecting")).toHaveLength(1);
    expect(other.connected).toBe(true);
    // The other client is unaffected and the flooder may come back and sync again.
    const again = await TestClient.connect(server, f, "owner", "owner");
    other.insert(0, "fine");
    await waitFor(() => again.text === "fine", "normal traffic");
  });

  it("refuses a connection beyond the per-document maximum", async () => {
    const server = await launch({ limits: { maxConnectionsPerDocument: 2 } });
    const f = await createDocument();
    const a = await TestClient.connect(server, f, "owner", "owner");
    await TestClient.connect(server, f, "editor", "editor");
    const refused = await connectErrorOf(server, f, "viewer", "viewer");
    expect(refused.code).toBe("too_many_connections");

    // Another document is not affected, and a freed place can be taken.
    const g = await createDocument();
    await TestClient.connect(server, g, "owner", "owner");
    a.close();
    await settle(150);
    const viewer = await TestClient.connect(server, f, "viewer", "viewer");
    expect(viewer.connected).toBe(true);
  });
});
