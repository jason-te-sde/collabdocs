import { z } from "zod";
import { handle, json, readBody } from "@/lib/api";
import { getDb, isUniqueViolation } from "@/lib/db";
import { normalizeEmail } from "@/lib/email";
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/passwords";
import { clientIp, enforceRegisterLimit } from "@/lib/rate-limit";
import { sendAccountExistsEmail, sendVerificationEmail } from "@/lib/verification";

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
  // The answer is the same whether or not the address has an account: an endpoint that
  // said "taken" would list the registered addresses for anyone. The owner of an address
  // that already has an account is told by email instead.
  let created = false;
  try {
    await getDb().user.create({ data: { email, name: body.name ?? null, passwordHash } });
    created = true;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  let verification: "sent" | "failed" = "sent";
  try {
    // The account works at once; an unverified address only holds back invitations to it.
    if (created) await sendVerificationEmail(email);
    else await sendAccountExistsEmail(email);
  } catch (error) {
    console.error("could not send the registration email", error);
    verification = "failed";
  }
  return json({ user: { email, name: body.name ?? null }, verification }, 201);
});
