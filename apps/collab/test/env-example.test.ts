import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { optionsFromEnv } from "../src/config";

const SECRET = "test-collab-secret-0123456789-abcdefghij";
const base = { DATABASE_URL: "postgresql://localhost/x", COLLAB_TOKEN_SECRET: SECRET };

const readText = (relative: string) => readFileSync(new URL(relative, import.meta.url), "utf8");
const example = readText("../../web/.env.example");
const configSource = readText("../src/config.ts");
const readme = readText("../../../README.md");
const operations = readText("../../../docs/operations.md");

/** The COLLAB_ variables the server reads, found in its configuration code. */
const used = [...new Set(configSource.match(/COLLAB_[A-Z_]+/g))];

/** `# COLLAB_NAME="value"` lines of the example, as the environment they would give if uncommented. */
function commentedSettings(): Record<string, string> {
  const settings: Record<string, string> = {};
  for (const match of example.matchAll(/^# (COLLAB_[A-Z_]+)="([^"]*)"/gm)) {
    settings[match[1]!] = match[2]!;
  }
  return settings;
}

/** Variables the example shows as an illustration: they have no default to compare. */
const EXAMPLES_ONLY = ["COLLAB_HOST", "COLLAB_CORS_ORIGIN", "COLLAB_INSTANCE_ID"];

describe(".env.example", () => {
  it("shows the real default for every setting it says is a default", () => {
    const settings = commentedSettings();
    for (const name of EXAMPLES_ONLY) delete settings[name];
    const fromExample = optionsFromEnv({ ...base, ...settings });
    const defaults = optionsFromEnv(base);
    expect(fromExample.limits).toEqual(defaults.limits);
    expect(fromExample.persistence).toEqual(defaults.persistence);
    expect(fromExample).toMatchObject({
      port: defaults.port,
      redisConnectTimeoutMs: defaults.redisConnectTimeoutMs,
      connectionTtlMs: defaults.connectionTtlMs,
      trustedProxyHops: defaults.trustedProxyHops,
      rateLimiterMaxKeys: defaults.rateLimiterMaxKeys,
    });
  });

  it("lists every COLLAB_ variable the server reads, and so do the README and the operations guide", () => {
    expect(used.length).toBeGreaterThan(25);
    for (const [file, text] of [
      [".env.example", example],
      ["README.md", readme],
      ["docs/operations.md", operations],
    ] as const) {
      const missing = used.filter((name) => !text.includes(name));
      expect({ file, missing }).toEqual({ file, missing: [] });
    }
  });
});
