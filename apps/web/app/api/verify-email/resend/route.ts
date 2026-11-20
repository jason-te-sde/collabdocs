import { handle, json, requireUser } from "@/lib/api";
import { getDb } from "@/lib/db";
import { enforceVerifyResendLimit } from "@/lib/rate-limit";
import { sendVerificationEmail } from "@/lib/verification";

/** Sends the signed-in user a fresh verification link. */
export const POST = handle(async (_request: Request) => {
  const user = await requireUser();
  const row = await getDb().user.findUnique({
    where: { id: user.id },
    select: { emailVerified: true },
  });
  if (row?.emailVerified) return json({ alreadyVerified: true });
  await enforceVerifyResendLimit(user.email);
  await sendVerificationEmail(user.email);
  return json({ sent: true });
});
