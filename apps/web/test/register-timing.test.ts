import { describe, expect, it, vi } from "vitest";
import { POST as register } from "@/app/api/register/route";
import { getDb } from "@/lib/db";
import * as passwords from "@/lib/passwords";
import { jsonRequest } from "./helpers";

const PASSWORD = "a-long-enough-password";
const attempt = (email: string) => register(jsonRequest("POST", { email, password: PASSWORD }));

describe("registering a new address and an existing one", () => {
  it("does the same expensive work on both paths", async () => {
    await attempt("taken@example.test");
    const hash = vi.spyOn(passwords, "hashPassword");
    const writes = vi.spyOn(getDb().verificationToken, "create");
    try {
      await attempt("fresh@example.test");
      const fresh = { hashes: hash.mock.calls.length, writes: writes.mock.calls.length };
      hash.mockClear();
      writes.mockClear();
      await attempt("taken@example.test");
      const existing = { hashes: hash.mock.calls.length, writes: writes.mock.calls.length };
      expect(fresh).toEqual({ hashes: 1, writes: 1 });
      expect(existing).toEqual(fresh);
    } finally {
      hash.mockRestore();
      writes.mockRestore();
    }
  });

  it("leaves no token row behind on the existing-address path, and answers the same", async () => {
    const first = await attempt("taken@example.test");
    const tokensBefore = await getDb().verificationToken.count();
    const again = await attempt("taken@example.test");
    expect(again.status).toBe(first.status);
    expect(await again.json()).toEqual(await first.json());
    expect(await getDb().verificationToken.count()).toBe(tokensBefore);
  });

  it("takes about the same time (median of many runs)", async () => {
    await attempt("taken@example.test");
    const fresh: number[] = [];
    const existing: number[] = [];
    // Interleaved, so that a slow moment of the machine hits both sides alike.
    for (let i = 0; i < 40; i += 1) {
      let t = performance.now();
      await attempt(`fresh-${i}@example.test`);
      fresh.push(performance.now() - t);
      t = performance.now();
      await attempt("taken@example.test");
      existing.push(performance.now() - t);
    }
    const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
    const [a, b] = [median(fresh), median(existing)];
    console.log(`register timing: new ${a.toFixed(1)} ms, existing ${b.toFixed(1)} ms`);
    // Before the fix the existing path was about 40% faster. Allow noise, not that.
    expect(Math.abs(a - b) / Math.max(a, b)).toBeLessThan(0.25);
  });
});
