import { NextRequest } from "next/server";
import { handlers } from "@/auth";
import { handle, HttpError, MAX_BODY_BYTES, readCappedBytes } from "@/lib/api";
import { clientIp, enforceSignInLimit } from "@/lib/rate-limit";

export const { GET } = handlers;

/**
 * The email of a credentials sign-in as Auth.js will read it, and nothing else. Auth.js
 * decides the format with `includes` on the content type (JSON first), takes a JSON body
 * as it is and turns a form into an object in which the last value of a field wins
 * (`@auth/core` `lib/utils/web.js`). The same rules apply here, on the same bytes. A body
 * the two could read differently is refused: a form that repeats a field, a format
 * Auth.js would ignore, an email that is not a string.
 */
function emailOf(type: string, bytes: Uint8Array<ArrayBuffer>): string | null {
  const text = new TextDecoder().decode(bytes);
  const invalid = () => new HttpError(400, "invalid_body", "The sign-in body is not valid");
  let email: unknown;
  if (type.includes("application/json")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw invalid();
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw invalid();
    email = (parsed as Record<string, unknown>).email;
  } else if (type.includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams(text);
    const seen = new Set<string>();
    for (const name of params.keys()) {
      if (seen.has(name)) throw invalid();
      seen.add(name);
    }
    email = params.get("email") ?? undefined;
  } else {
    throw new HttpError(
      415,
      "unsupported_media_type",
      "Send the body as a form or as application/json",
    );
  }
  if (email === undefined) return null;
  if (typeof email !== "string") throw invalid();
  return email;
}

/**
 * Auth.js answers a failed credentials sign-in with a redirect, which cannot say
 * "too many attempts". The limit is therefore applied here, before Auth.js sees the
 * request, and answers 429 with Retry-After. The body is read once, here, and Auth.js
 * is given those same bytes.
 */
export const POST = handle(async (request: NextRequest) => {
  if (!new URL(request.url).pathname.endsWith("/callback/credentials")) {
    return handlers.POST(request);
  }
  const bytes = await readCappedBytes(request, MAX_BODY_BYTES);
  const email = emailOf(request.headers.get("content-type") ?? "", bytes);
  await enforceSignInLimit(clientIp(request.headers), email);
  return handlers.POST(
    new NextRequest(request.url, { method: "POST", headers: request.headers, body: bytes }),
  );
});
