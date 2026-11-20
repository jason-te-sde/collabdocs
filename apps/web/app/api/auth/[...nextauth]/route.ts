import type { NextRequest } from "next/server";
import { handlers } from "@/auth";
import { handle } from "@/lib/api";
import { clientIp, enforceSignInLimit } from "@/lib/rate-limit";

export const { GET } = handlers;

/**
 * Auth.js answers a failed credentials sign-in with a redirect, which cannot say
 * "too many attempts". The limit is therefore applied here, before Auth.js sees the
 * request, and answers 429 with Retry-After.
 */
export const POST = handle(async (request: NextRequest) => {
  if (new URL(request.url).pathname.endsWith("/callback/credentials")) {
    const form = await request
      .clone()
      .formData()
      .catch(() => null);
    const email = form?.get("email");
    await enforceSignInLimit(clientIp(request.headers), typeof email === "string" ? email : null);
  }
  return handlers.POST(request);
});
