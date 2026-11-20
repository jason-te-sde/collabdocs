import { z } from "zod";
import { handle, HttpError, json, readBody } from "@/lib/api";
import { clientIp, enforceVerifyLimit } from "@/lib/rate-limit";
import { verifyEmailToken } from "@/lib/verification";

const schema = z.object({ token: z.string().min(16).max(128) });

/**
 * Confirms an email address. It is a POST, sent by the page that the emailed link
 * opens, so that a mail scanner that fetches the link does not use the token up.
 */
export const POST = handle(async (request: Request) => {
  // Tokens are 256 random bits, so guessing one is not a risk; the limit stops this
  // route from being a free database-lookup service.
  await enforceVerifyLimit(clientIp(request.headers));
  const { token } = await readBody(request, schema);
  const result = await verifyEmailToken(token);
  if (!result.ok) {
    throw new HttpError(400, "invalid_token", "This link is invalid or has expired");
  }
  return json({ verified: true, email: result.email });
});
