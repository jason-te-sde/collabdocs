import { afterEach, describe, expect, it } from "vitest";
import { POST as register } from "@/app/api/register/route";
import { POST as resend } from "@/app/api/verify-email/resend/route";
import { POST as verify } from "@/app/api/verify-email/route";
import { getDb } from "@/lib/db";
import { createUser, jsonRequest, mailTo, signInAs } from "./helpers";

const PASSWORD = "correct horse battery staple";
const LIMIT_VARIABLES = [
  "AUTH_LIMIT_REGISTER_PER_IP",
  "AUTH_LIMIT_REGISTER_PER_ACCOUNT",
  "AUTH_LIMIT_VERIFY_RESEND_PER_ACCOUNT",
  "AUTH_LIMIT_SIGNIN_PER_IP",
];

afterEach(() => {
  for (const name of LIMIT_VARIABLES) process.env[name] = "1000";
});

/** `ip` is what the proxy saw; the first entry is whatever the client claims. */
const signUp = (email: string, ip: string, claimed = "6.6.6.6") =>
  register(
    jsonRequest("POST", { email, password: PASSWORD }, { "x-forwarded-for": `${claimed}, ${ip}` }),
  );

describe("registration is rate limited", () => {
  it("per address of the client, whatever the client claims", async () => {
    process.env.AUTH_LIMIT_REGISTER_PER_IP = "3";
    for (let n = 1; n <= 3; n += 1) {
      expect((await signUp(`user${n}@example.test`, "203.0.113.1", `9.9.9.${n}`)).status).toBe(201);
    }
    const refused = await signUp("user4@example.test", "203.0.113.1", "9.9.9.4");
    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await refused.json()).error.code).toBe("rate_limited");
    // The refused request did nothing.
    expect(await getDb().user.count({ where: { email: "user4@example.test" } })).toBe(0);
    expect(await mailTo("user4@example.test")).toHaveLength(0);
    // Another client is not affected.
    expect((await signUp("user5@example.test", "203.0.113.2")).status).toBe(201);
  });

  it("per account, so that one address cannot be hammered from many clients", async () => {
    process.env.AUTH_LIMIT_REGISTER_PER_ACCOUNT = "2";
    expect((await signUp("target@example.test", "203.0.113.1")).status).toBe(201);
    expect((await signUp("target@example.test", "203.0.113.2")).status).toBe(409);
    // The third attempt is refused as too many, not answered with "already taken".
    expect((await signUp("Target@Example.Test", "203.0.113.3")).status).toBe(429);
    expect((await mailTo("target@example.test")).length).toBe(1);
  });
});

describe("the other account routes are rate limited", () => {
  it("limits how often a verification link can be requested for one account", async () => {
    process.env.AUTH_LIMIT_VERIFY_RESEND_PER_ACCOUNT = "2";
    const user = await createUser("slow", false);
    signInAs(user.id);
    expect((await resend(jsonRequest("POST", {}))).status).toBe(200);
    expect((await resend(jsonRequest("POST", {}))).status).toBe(200);
    const refused = await resend(jsonRequest("POST", {}));
    expect(refused.status).toBe(429);
    expect(refused.headers.get("retry-after")).toBeTruthy();
    expect(await mailTo("slow@example.test")).toHaveLength(2);
  });

  it("limits attempts to confirm an address, per client", async () => {
    process.env.AUTH_LIMIT_SIGNIN_PER_IP = "2";
    const attempt = () =>
      verify(
        jsonRequest(
          "POST",
          { token: "x".repeat(43) },
          { "x-forwarded-for": "6.6.6.6, 203.0.113.9" },
        ),
      );
    expect((await attempt()).status).toBe(400);
    expect((await attempt()).status).toBe(400);
    expect((await attempt()).status).toBe(429);
  });
});
