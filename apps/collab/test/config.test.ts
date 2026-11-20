import { describe, expect, it } from "vitest";
import { DEFAULT_LIMITS, DEFAULT_PERSISTENCE, optionsFromEnv, resolveOptions } from "../src/config";

const SECRET = "test-collab-secret-0123456789-abcdefghij";
const REDIS_SECRET = "test-redis-message-secret-0123456789-abcd";
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
      maxConnectionsPerUser: 8,
      handshakeBurstPerUser: 20,
      handshakesPerSecondPerUser: 1,
      handshakeBurstPerIp: 2000,
      handshakesPerSecondPerIp: 100,
      maxBytesPerSecondPerUser: 524_288,
      byteBurstPerUser: 4_194_304,
      maxInFlightBytes: 67_108_864,
      maxPendingStructBytes: 1_048_576,
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
      REDIS_MESSAGE_SECRET: REDIS_SECRET,
      COLLAB_PORT: "5000",
      COLLAB_CORS_ORIGIN: "https://a.test, https://b.test",
      COLLAB_MAX_UPDATE_BYTES: "10",
      COLLAB_MAX_MESSAGES_PER_SECOND: "11",
      COLLAB_MESSAGE_BURST: "12",
      COLLAB_MAX_CONNECTIONS_PER_DOCUMENT: "13",
      COLLAB_MAX_CONNECTIONS_PER_USER: "31",
      COLLAB_HANDSHAKE_BURST_PER_USER: "32",
      COLLAB_HANDSHAKES_PER_SECOND_PER_USER: "33",
      COLLAB_HANDSHAKE_BURST_PER_IP: "34",
      COLLAB_HANDSHAKES_PER_SECOND_PER_IP: "35",
      COLLAB_MAX_BYTES_PER_SECOND_PER_USER: "36",
      COLLAB_BYTE_BURST_PER_USER: "37",
      COLLAB_MAX_IN_FLIGHT_BYTES: "38",
      COLLAB_MAX_PENDING_STRUCT_BYTES: "39",
      COLLAB_TRUSTED_PROXY_HOPS: "2",
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
      redisMessageSecret: REDIS_SECRET,
      corsOrigin: ["https://a.test", "https://b.test"],
      trustedProxyHops: 2,
      limits: {
        maxConnectionsPerUser: 31,
        handshakeBurstPerUser: 32,
        handshakesPerSecondPerUser: 33,
        handshakeBurstPerIp: 34,
        handshakesPerSecondPerIp: 35,
        maxBytesPerSecondPerUser: 36,
        byteBurstPerUser: 37,
        maxInFlightBytes: 38,
        maxPendingStructBytes: 39,
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

  it("needs a message secret, a long and different one, when Redis is used", () => {
    const withRedis = { ...base, REDIS_URL: "redis://r:6379" };
    expect(() => optionsFromEnv(withRedis)).toThrow(/REDIS_MESSAGE_SECRET is required/);
    expect(() => optionsFromEnv({ ...withRedis, REDIS_MESSAGE_SECRET: "short" })).toThrow(
      /32 bytes/,
    );
    expect(() => optionsFromEnv({ ...withRedis, REDIS_MESSAGE_SECRET: SECRET })).toThrow(/differ/);
    expect(optionsFromEnv({ ...withRedis, REDIS_MESSAGE_SECRET: REDIS_SECRET }).redisUrl).toBe(
      "redis://r:6379",
    );
    // Without Redis the secret is not needed.
    expect(optionsFromEnv(base).redisMessageSecret).toBeUndefined();
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
