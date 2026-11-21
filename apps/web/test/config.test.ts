import { afterEach, describe, expect, it, vi } from "vitest";
import { register } from "@/instrumentation";
import { assertRuntimeConfig } from "@/lib/config";
import { appUrl } from "@/lib/verification";

const SECRET = "test-redis-message-secret-0123456789-abcd";
const base = {
  REDIS_URL: "redis://localhost:6379",
  COLLAB_TOKEN_SECRET: "test-collab-secret-0123456789-abcdefghij",
  AUTH_SECRET: "test-auth-secret-that-differs-0123456789",
};

afterEach(() => vi.unstubAllEnvs());

describe("assertRuntimeConfig", () => {
  it("accepts a long secret that differs from the others", () => {
    expect(() => assertRuntimeConfig({ ...base, REDIS_MESSAGE_SECRET: SECRET })).not.toThrow();
  });

  it("refuses to run with Redis and no secret, a short one, or one shared with another secret", () => {
    expect(() => assertRuntimeConfig(base)).toThrow(/REDIS_MESSAGE_SECRET is required/);
    expect(() => assertRuntimeConfig({ ...base, REDIS_MESSAGE_SECRET: "" })).toThrow(/required/);
    expect(() => assertRuntimeConfig({ ...base, REDIS_MESSAGE_SECRET: "short" })).toThrow(
      /32 bytes/,
    );
    expect(() =>
      assertRuntimeConfig({ ...base, REDIS_MESSAGE_SECRET: base.COLLAB_TOKEN_SECRET }),
    ).toThrow(/differ from COLLAB_TOKEN_SECRET/);
    expect(() =>
      assertRuntimeConfig({
        ...base,
        AUTH_SECRET: SECRET,
        REDIS_MESSAGE_SECRET: SECRET,
      }),
    ).toThrow(/differ from AUTH_SECRET/);
  });

  it("asks for nothing without Redis", () => {
    expect(() => assertRuntimeConfig({})).not.toThrow();
  });
});

describe("AUTH_URL", () => {
  it("is required in production and optional in development", () => {
    expect(() => assertRuntimeConfig({ NODE_ENV: "production" })).toThrow(/AUTH_URL is required/);
    expect(() => assertRuntimeConfig({ NODE_ENV: "production", AUTH_URL: "" })).toThrow(
      /AUTH_URL is required/,
    );
    expect(() =>
      assertRuntimeConfig({ NODE_ENV: "production", AUTH_URL: "https://docs.example.com" }),
    ).not.toThrow();
    expect(() => assertRuntimeConfig({ NODE_ENV: "development" })).not.toThrow();
    expect(() => assertRuntimeConfig({})).not.toThrow();
  });

  it("falls back to localhost for links in development only", () => {
    expect(appUrl({ NODE_ENV: "development" })).toBe("http://localhost:3000");
    expect(appUrl({ AUTH_URL: "https://docs.example.com/" })).toBe("https://docs.example.com");
    expect(() => appUrl({ NODE_ENV: "production" })).toThrow(/AUTH_URL/);
  });
});

describe("the server's start", () => {
  it("runs the check", async () => {
    vi.stubEnv("NEXT_RUNTIME", "nodejs");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("REDIS_MESSAGE_SECRET", "short");
    await expect(register()).rejects.toThrow(/32 bytes/);
  });

  it("leaves the edge runtime alone", async () => {
    vi.stubEnv("NEXT_RUNTIME", "edge");
    vi.stubEnv("REDIS_URL", "redis://localhost:6379");
    vi.stubEnv("REDIS_MESSAGE_SECRET", "short");
    await expect(register()).resolves.toBeUndefined();
  });
});
