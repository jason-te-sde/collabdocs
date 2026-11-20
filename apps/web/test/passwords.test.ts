import * as argon2 from "@node-rs/argon2";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hashPassword, verifyPassword } from "@/lib/passwords";

vi.mock("@node-rs/argon2", async (importOriginal) => {
  const actual = await importOriginal<typeof argon2>();
  return { ...actual, verify: vi.fn(actual.verify), hash: vi.fn(actual.hash) };
});

beforeEach(() => {
  vi.mocked(argon2.verify).mockClear();
});

describe("verifyPassword", () => {
  it("accepts the right password and refuses a wrong one", async () => {
    const stored = await hashPassword("a long enough passphrase");
    expect(await verifyPassword(stored, "a long enough passphrase")).toBe(true);
    expect(await verifyPassword(stored, "another passphrase")).toBe(false);
  });

  it("does the same work for a user with no hash as for one with a hash", async () => {
    const stored = await hashPassword("a long enough passphrase");
    vi.mocked(argon2.verify).mockClear();
    await verifyPassword(stored, "wrong");
    const withHash = vi.mocked(argon2.verify).mock.calls.length;
    vi.mocked(argon2.verify).mockClear();
    expect(await verifyPassword(null, "wrong")).toBe(false);
    expect(await verifyPassword(undefined, "wrong")).toBe(false);
    // One full argon2 verification each time, so the response time does not show
    // whether the email is registered or has a password at all.
    expect(withHash).toBe(1);
    expect(vi.mocked(argon2.verify).mock.calls.length).toBe(2);
  });

  it("never accepts a password for a user with no hash", async () => {
    expect(await verifyPassword(null, "collabdocs-timing-equaliser")).toBe(false);
  });
});
