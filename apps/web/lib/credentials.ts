import { z } from "zod";
import { getDb } from "./db";
import { normalizeEmail } from "./email";
import { MAX_PASSWORD_LENGTH, verifyPassword } from "./passwords";

const signInSchema = z.object({
  email: z.email().max(254),
  password: z.string().min(1).max(MAX_PASSWORD_LENGTH),
});

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string | null;
}

/** The Auth.js credentials check: the user, or null. Never says which part was wrong. */
export async function authenticate(credentials: unknown): Promise<AuthenticatedUser | null> {
  const parsed = signInSchema.safeParse(credentials);
  if (!parsed.success) return null;
  const user = await getDb().user.findUnique({
    where: { email: normalizeEmail(parsed.data.email) },
  });
  const ok = await verifyPassword(user?.passwordHash, parsed.data.password);
  if (!user || !ok) return null;
  return { id: user.id, email: user.email, name: user.name };
}
