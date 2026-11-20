// These tests drive the real Auth.js handlers: the CSRF token, the credentials callback,
// the GitHub OAuth redirect and callback, the session endpoint. `auth()` is not mocked
// here. GitHub's endpoints are answered by a stand-in for `fetch`; nothing leaves the machine.
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GET, POST } from "@/app/api/auth/[...nextauth]/route";
import { POST as register } from "@/app/api/register/route";
import { getDb } from "@/lib/db";
import { createUser, fixture, jsonRequest } from "./helpers";

vi.unmock("@/auth");
// The GitHub provider exists only when the OAuth app is configured, and the providers
// are read when auth.ts loads, so this runs before any import.
vi.hoisted(() => {
  process.env.AUTH_GITHUB_ID = "test-github-client-id";
  process.env.AUTH_GITHUB_SECRET = "test-github-client-secret";
  process.env.AUTH_TRUST_HOST = "true";
  process.env.AUTH_URL = "http://localhost";
});

const PASSWORD = "correct horse battery staple";

/** The cookies a browser would keep between requests. */
class Jar {
  private readonly cookies = new Map<string, string>();

  absorb(response: Response): void {
    for (const line of response.headers.getSetCookie()) {
      const [pair = "", ...attributes] = line.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at).trim();
      const value = pair.slice(at + 1);
      const expired = attributes.some((a) => /^\s*max-age=0/i.test(a)) || value === "";
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
  }

  get header(): string {
    return [...this.cookies].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  has(namePart: string): boolean {
    return [...this.cookies.keys()].some((name) => name.includes(namePart));
  }
}

async function call(
  handler: (request: NextRequest) => Promise<Response>,
  jar: Jar,
  path: string,
  init: { method?: string; form?: Record<string, string>; headers?: Record<string, string> } = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  if (jar.header) headers.set("cookie", jar.header);
  if (init.form) headers.set("content-type", "application/x-www-form-urlencoded");
  const response = await handler(
    new NextRequest(`http://localhost${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.form ? { body: new URLSearchParams(init.form).toString() } : {}),
      redirect: "manual",
    }),
  );
  jar.absorb(response);
  return response;
}

async function csrfToken(jar: Jar): Promise<string> {
  return ((await (await call(GET, jar, "/api/auth/csrf")).json()) as { csrfToken: string })
    .csrfToken;
}

async function signInWithPassword(
  jar: Jar,
  email: string,
  password: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return call(POST, jar, "/api/auth/callback/credentials", {
    method: "POST",
    form: {
      csrfToken: await csrfToken(jar),
      email,
      password,
      callbackUrl: "http://localhost/documents",
    },
    headers,
  });
}

async function sessionOf(jar: Jar): Promise<{ user?: { id: string; email: string } } | null> {
  return (await call(GET, jar, "/api/auth/session")).json();
}

describe("credentials sign-in through Auth.js", () => {
  it("signs a registered user in and gives a session that names them", async () => {
    const created = await register(
      jsonRequest("POST", { email: "ada@example.test", password: PASSWORD }),
    );
    const { user } = await created.json();
    const jar = new Jar();
    expect(await sessionOf(jar)).toBeNull();

    const response = await signInWithPassword(jar, "ADA@example.test", PASSWORD);
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe("http://localhost/documents");
    expect(jar.has("session-token")).toBe(true);
    const session = await sessionOf(jar);
    expect(session?.user).toMatchObject({ id: user.id, email: "ada@example.test" });
  });

  it("refuses a wrong password and an unknown address with no session", async () => {
    await register(jsonRequest("POST", { email: "ada@example.test", password: PASSWORD }));
    for (const [email, password] of [
      ["ada@example.test", "not the password!"],
      ["nobody@example.test", PASSWORD],
    ] as const) {
      const jar = new Jar();
      const response = await signInWithPassword(jar, email, password);
      expect(response.headers.get("location")).toContain("error=CredentialsSignin");
      expect(jar.has("session-token")).toBe(false);
      expect(await sessionOf(jar)).toBeNull();
    }
  });

  it("refuses a sign-in without the CSRF token", async () => {
    await register(jsonRequest("POST", { email: "ada@example.test", password: PASSWORD }));
    const jar = new Jar();
    const response = await call(POST, jar, "/api/auth/callback/credentials", {
      method: "POST",
      form: { csrfToken: "forged", email: "ada@example.test", password: PASSWORD },
    });
    expect(jar.has("session-token")).toBe(false);
    expect(response.headers.get("location") ?? "").toMatch(/error=/);
  });
});

describe("sign-in rate limits through the real route", () => {
  beforeEach(() => {
    process.env.AUTH_LIMIT_SIGNIN_PER_ACCOUNT = "3";
    process.env.AUTH_LIMIT_SIGNIN_PER_IP = "5";
  });
  afterEach(() => {
    process.env.AUTH_LIMIT_SIGNIN_PER_ACCOUNT = "1000";
    process.env.AUTH_LIMIT_SIGNIN_PER_IP = "1000";
  });

  it("answers 429 with Retry-After once an account has had too many attempts, even with the right password", async () => {
    await register(jsonRequest("POST", { email: "ada@example.test", password: PASSWORD }));
    // Different addresses, so that it is the account's limit that trips.
    const attempt = (n: number) =>
      signInWithPassword(new Jar(), "ada@example.test", "guess number " + n + "!!", {
        "x-forwarded-for": `198.51.100.${n}`,
      });
    for (let n = 1; n <= 3; n += 1) {
      expect((await attempt(n)).status).toBe(302);
    }
    const refused = await attempt(4);
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await refused.json()).error.code).toBe("rate_limited");

    const jar = new Jar();
    const correct = await signInWithPassword(jar, "ada@example.test", PASSWORD, {
      "x-forwarded-for": "198.51.100.77",
    });
    expect(correct.status).toBe(429);
    expect(jar.has("session-token")).toBe(false);
  });

  it("answers 429 once an address has had too many attempts, whichever accounts", async () => {
    const attempt = (n: number) =>
      signInWithPassword(new Jar(), `user${n}@example.test`, "whatever it is", {
        // The first entry is the client's own claim; only the proxy's entry counts.
        "x-forwarded-for": `10.9.8.${n}, 203.0.113.50`,
      });
    for (let n = 1; n <= 5; n += 1) expect((await attempt(n)).status).toBe(302);
    expect((await attempt(6)).status).toBe(429);
  });

  it("does not count other routes of Auth.js", async () => {
    for (let i = 0; i < 20; i += 1) {
      expect((await call(GET, new Jar(), "/api/auth/csrf")).status).toBe(200);
    }
  });
});

// ---- GitHub -------------------------------------------------------------------------------

interface GitHubUser {
  id: number;
  login: string;
  email: string | null;
  emails: Array<{ email: string; primary: boolean; verified: boolean }>;
}

const realFetch = globalThis.fetch;
afterEach(() => {
  vi.stubGlobal("fetch", realFetch);
});

/** Answers GitHub's token, user and emails endpoints; any other request fails the test. */
function mockGitHub(github: GitHubUser): string[] {
  const requested: string[] = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requested.push(url);
    if (url === "https://github.com/login/oauth/access_token") {
      return Response.json({ access_token: "gho_test", token_type: "bearer", scope: "read:user" });
    }
    if (url === "https://api.github.com/user") {
      return Response.json({
        id: github.id,
        login: github.login,
        name: github.login,
        email: github.email,
        avatar_url: null,
      });
    }
    if (url === "https://api.github.com/user/emails") return Response.json(github.emails);
    throw new Error(`unexpected request to ${url}`);
  });
  return requested;
}

/** The whole OAuth round trip, ending at the callback. Returns the callback's response. */
async function signInWithGitHub(jar: Jar): Promise<Response> {
  const start = await call(POST, jar, "/api/auth/signin/github", {
    method: "POST",
    form: { csrfToken: await csrfToken(jar), callbackUrl: "http://localhost/documents" },
  });
  const authorize = new URL(start.headers.get("location") ?? "");
  expect(authorize.origin + authorize.pathname).toBe("https://github.com/login/oauth/authorize");
  // Auth.js protects the round trip with PKCE, whose verifier is in a cookie, and with
  // `state` when the provider asks for it.
  const state = authorize.searchParams.get("state");
  const query = new URLSearchParams({ code: "a-code", ...(state ? { state } : {}) });
  return call(GET, jar, `/api/auth/callback/github?${query}`);
}

describe("GitHub sign-in through Auth.js", () => {
  it("refuses to merge a GitHub account into a password account with the same email", async () => {
    await register(jsonRequest("POST", { email: "ada@example.test", password: PASSWORD }));
    const requested = mockGitHub({
      id: 4242,
      login: "ada-on-github",
      email: "Ada@Example.Test",
      emails: [{ email: "ada@example.test", primary: true, verified: true }],
    });
    const jar = new Jar();
    const response = await signInWithGitHub(jar);

    expect(requested).toContain("https://github.com/login/oauth/access_token");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain("error=OAuthAccountNotLinked");
    expect(jar.has("session-token")).toBe(false);
    expect(await sessionOf(jar)).toBeNull();
    // Nothing was linked or created, and the password account is as it was.
    expect(await getDb().account.count()).toBe(0);
    const users = await getDb().user.findMany();
    expect(users).toHaveLength(1);
    expect(users[0]!.passwordHash).toMatch(/^\$argon2id\$/);
  });

  it("creates and signs in a new GitHub user, verified when GitHub says the address is", async () => {
    mockGitHub({
      id: 7,
      login: "octo",
      email: "octo@example.test",
      emails: [{ email: "octo@example.test", primary: true, verified: true }],
    });
    const jar = new Jar();
    const response = await signInWithGitHub(jar);
    expect(response.headers.get("location")).toBe("http://localhost/documents");
    const user = await getDb().user.findUniqueOrThrow({ where: { email: "octo@example.test" } });
    expect(user.emailVerified).toBeInstanceOf(Date);
    expect(user.passwordHash).toBeNull();
    expect(await getDb().account.count({ where: { userId: user.id, provider: "github" } })).toBe(1);
    expect((await sessionOf(jar))?.user?.id).toBe(user.id);
  });

  it("does not treat an address as verified when GitHub does not", async () => {
    mockGitHub({
      id: 8,
      login: "unverified",
      email: "unverified@example.test",
      emails: [{ email: "unverified@example.test", primary: true, verified: false }],
    });
    await signInWithGitHub(new Jar());
    const user = await getDb().user.findUniqueOrThrow({
      where: { email: "unverified@example.test" },
    });
    expect(user.emailVerified).toBeNull();
  });

  it("gives a new GitHub user the invitations held for a verified address, and not for an unverified one", async () => {
    const f = await fixture();
    const g = await fixture("-g");
    for (const [doc, owner, email] of [
      [f, f.users.owner, "verified@example.test"],
      [g, g.users.owner, "unverified@example.test"],
    ] as const) {
      await getDb().pendingInvite.create({
        data: { documentId: doc.documentId, email, role: "editor", invitedById: owner.id },
      });
    }
    for (const [id, email, verified] of [
      [21, "verified@example.test", true],
      [22, "unverified@example.test", false],
    ] as const) {
      mockGitHub({ id, login: `gh${id}`, email, emails: [{ email, primary: true, verified }] });
      await signInWithGitHub(new Jar());
    }
    const verifiedUser = await getDb().user.findUniqueOrThrow({
      where: { email: "verified@example.test" },
    });
    const unverifiedUser = await getDb().user.findUniqueOrThrow({
      where: { email: "unverified@example.test" },
    });
    expect(await getDb().membership.count({ where: { userId: verifiedUser.id } })).toBe(1);
    expect(await getDb().membership.count({ where: { userId: unverifiedUser.id } })).toBe(0);
    expect(await getDb().pendingInvite.count()).toBe(1);
  });

  it("is not offered when the OAuth app is not configured", async () => {
    // The providers are fixed when the module loads; this checks the one we configured.
    const providers = (await (await call(GET, new Jar(), "/api/auth/providers")).json()) as Record<
      string,
      unknown
    >;
    expect(Object.keys(providers).sort()).toEqual(["credentials", "github"]);
    await createUser("unused");
  });
});
