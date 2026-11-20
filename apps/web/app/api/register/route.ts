import { z } from "zod";
import { handle, HttpError, json, readBody } from "@/lib/api";
import { getDb, isUniqueViolation } from "@/lib/db";
import { normalizeEmail } from "@/lib/email";
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/passwords";
import { clientIp, enforceRegisterLimit } from "@/lib/rate-limit";
import { sendVerificationEmail } from "@/lib/verification";

const schema = z.object({
  email: z.email().max(254),
  password: z.string().min(MIN_PASSWORD_LENGTH).max(MAX_PASSWORD_LENGTH),
  name: z.string().trim().min(1).max(100).optional(),
});

export const POST = handle(async (request: Request) => {
  const body = await readBody(request, schema);
  const email = normalizeEmail(body.email);
  // Before the expensive hash: per address of the client, and per account, so that
  // registering is no way to flood one person's inbox with verification mail.
  await enforceRegisterLimit(clientIp(request.headers), email);
  const passwordHash = await hashPassword(body.password);
  try {
    const user = await getDb().user.create({
      data: { email, name: body.name ?? null, passwordHash },
      select: { id: true, email: true, name: true },
    });
    // The account works at once; an unverified address only holds back invitations to it.
    let verification: "sent" | "failed" = "sent";
    try {
      await sendVerificationEmail(email);
    } catch (error) {
      console.error("could not send the verification email", error);
      verification = "failed";
    }
    return json({ user, verification }, 201);
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, "email_taken", "An account with this email already exists");
    }
    throw error;
  }
});
