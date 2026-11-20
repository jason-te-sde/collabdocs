import { afterEach, describe, expect, it, vi } from "vitest";
import { signInAction } from "@/app/actions";
import { signIn } from "@/auth";

vi.mock("@/auth", () => ({ auth: vi.fn(), signIn: vi.fn(), signOut: vi.fn() }));
vi.mock("next/headers", () => ({
  headers: () => Promise.resolve(new Headers({ "x-forwarded-for": "6.6.6.6, 203.0.113.5" })),
}));

afterEach(() => {
  process.env.AUTH_LIMIT_SIGNIN_PER_ACCOUNT = "1000";
  vi.mocked(signIn).mockClear();
});

function form(email: string): FormData {
  const data = new FormData();
  data.set("email", email);
  data.set("password", "whatever it is");
  return data;
}

describe("the sign-in form's action", () => {
  it("says so, and does not try the password, once the account has had too many attempts", async () => {
    process.env.AUTH_LIMIT_SIGNIN_PER_ACCOUNT = "2";
    expect((await signInAction({ error: null }, form("ada@example.test"))).error).toBeNull();
    expect((await signInAction({ error: null }, form("ada@example.test"))).error).toBeNull();
    expect(signIn).toHaveBeenCalledTimes(2);

    const refused = await signInAction({ error: null }, form("ADA@example.test"));
    expect(refused.error).toMatch(/Too many attempts/);
    expect(signIn).toHaveBeenCalledTimes(2);
  });
});
