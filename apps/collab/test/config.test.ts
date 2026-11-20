import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, DEFAULT_PERSISTENCE, optionsFromEnv, resolveOptions } from "../src/config";

const SECRET = "test-collab-secret-0123456789-abcdefghij";
const base = { DATABASE_URL: "postgresql://localhost/x", COLLAB_TOKEN_SECRET: SECRET };

describe("configuration", () => {
  it("uses the documented defaults", () => {
    const options = optionsFromEnv(base);
    expect(options.limits).toEqual(DEFAULT_LIMITS);
    expect(options.persistence).toEqual(DEFAULT_PERSISTENCE);
    expect(options.port).toBe(4000);
    expect(options.redisUrl).toBeUndefined();
    expect(DEFAULT_LIMITS).toEqual({
      maxUpdateBytes: 1_048_576,
      maxMessagesPerSecond: 100,
      messageBurst: 200,
      maxConnectionsPerDocument: 250,
      maxBytesPerSecond: 262_144,
      byteBurst: 2_097_152,
      maxDocumentBytes: 16_777_216,
      maxPendingBytes: 8_388_608,
      maxAwarenessBytes: 8_192,
    });
    expect(DEFAULT_PERSISTENCE).toEqual({
      compactEveryUpdates: 200,
      compactAfterMs: 30_000,
      unloadGraceMs: 30_000,
      reconcileIntervalMs: 5_000,
      membershipRecheckMs: 60_000,
      roleCacheMs: 1_000,
    });
  });

  it("reads every limit and persistence setting from the environment", () => {
    const options = optionsFromEnv({
      ...base,
      REDIS_URL: "redis://r:6379",
      COLLAB_PORT: "5000",
      COLLAB_CORS_ORIGIN: "https://a.test, https://b.test",
      COLLAB_MAX_UPDATE_BYTES: "10",
      COLLAB_MAX_MESSAGES_PER_SECOND: "11",
      COLLAB_MESSAGE_BURST: "12",
      COLLAB_MAX_CONNECTIONS_PER_DOCUMENT: "13",
      COLLAB_MAX_BYTES_PER_SECOND: "21",
      COLLAB_BYTE_BURST: "22",
      COLLAB_MAX_DOCUMENT_BYTES: "23",
      COLLAB_MAX_PENDING_BYTES: "24",
      COLLAB_MAX_AWARENESS_BYTES: "25",
      COLLAB_COMPACT_EVERY_UPDATES: "14",
      COLLAB_COMPACT_AFTER_MS: "15",
      COLLAB_UNLOAD_GRACE_MS: "16",
      COLLAB_RECONCILE_INTERVAL_MS: "17",
      COLLAB_MEMBERSHIP_RECHECK_MS: "18",
      COLLAB_ROLE_CACHE_MS: "19",
    });
    expect(options).toMatchObject({
      port: 5000,
      redisUrl: "redis://r:6379",
      corsOrigin: ["https://a.test", "https://b.test"],
      limits: {
        maxUpdateBytes: 10,
        maxMessagesPerSecond: 11,
        messageBurst: 12,
        maxConnectionsPerDocument: 13,
        maxBytesPerSecond: 21,
        byteBurst: 22,
        maxDocumentBytes: 23,
        maxPendingBytes: 24,
        maxAwarenessBytes: 25,
      },
      persistence: {
        compactEveryUpdates: 14,
        compactAfterMs: 15,
        unloadGraceMs: 16,
        reconcileIntervalMs: 17,
        membershipRecheckMs: 18,
        roleCacheMs: 19,
      },
    });
  });

  it("refuses a missing database, a missing or short secret, and bad numbers", () => {
    expect(() => optionsFromEnv({ COLLAB_TOKEN_SECRET: SECRET })).toThrow(/DATABASE_URL/);
    expect(() => optionsFromEnv({ DATABASE_URL: "x" })).toThrow(/COLLAB_TOKEN_SECRET/);
    expect(() => optionsFromEnv({ ...base, COLLAB_TOKEN_SECRET: "short" })).toThrow(/32 bytes/);
    expect(() => optionsFromEnv({ ...base, COLLAB_MAX_UPDATE_BYTES: "lots" })).toThrow(/number/);
    expect(() => optionsFromEnv({ ...base, COLLAB_MESSAGE_BURST: "0" })).toThrow(/positive/);
    expect(() =>
      resolveOptions({ databaseUrl: "x", tokenSecret: SECRET, limits: { maxUpdateBytes: -1 } }),
    ).toThrow(/positive/);
    expect(() =>
      resolveOptions({
        databaseUrl: "x",
        tokenSecret: SECRET,
        limits: { maxUpdateBytes: 1000, byteBurst: 999 },
      }),
    ).toThrow(/byteBurst/);
  });
});
