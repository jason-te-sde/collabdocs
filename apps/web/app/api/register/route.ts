import { z } from "zod";
import { handle, json, readBody } from "@/lib/api";
import { getDb } from "@/lib/db";
import { normalizeEmail } from "@/lib/email";
import { hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from "@/lib/passwords";
import { clientIp, enforceRegisterLimit } from "@/lib/rate-limit";
import {
  matchVerificationWrite,
  sendAccountExistsEmail,
  sendVerificationEmail,
} from "@/lib/verification";

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
  // One INSERT ... ON CONFLICT DO NOTHING, so that an address that exists costs the same as
  // one that does not: a unique violation raised and caught would be measurably slower.
  const { count } = await getDb().user.createMany({
    data: [{ email, name: body.name ?? null, passwordHash }],
    skipDuplicates: true,
  });
  const created = count === 1;
  let verification: "sent" | "failed" = "sent";
  try {
    // The account works at once; an unverified address only holds back invitations to it.
    if (created) {
      await sendVerificationEmail(email);
    } else {
      // The new-address path hashes the password, inserts a user and a token, and sends
      // one mail. This one hashed the password above; it also does the token's database
      // work and sends one mail, so the two take the same time.
      await matchVerificationWrite(email);
      await sendAccountExistsEmail(email);
    }
  } catch (error) {
    console.error("could not send the registration email", error);
    verification = "failed";
  }
  return json({ user: { email, name: body.name ?? null }, verification }, 201);
});
