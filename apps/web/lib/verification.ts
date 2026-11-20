import { createHash, randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { getDb } from "./db";
import { normalizeEmail } from "./email";
import { getMailer } from "./mailer";

export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/** The database holds only the hash: a copy of the table cannot be used to verify anyone. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function appUrl(): string {
  return (process.env.AUTH_URL ?? "http://localhost:3000").replace(/\/+$/, "");
}

/**
 * Makes a new verification token for the address, replacing any older one, and
 * emails the link. Returns the token (for tests of the mail's content, not for
 * callers to hand out). Throws if the mailer does.
 */
export async function sendVerificationEmail(email: string, now = Date.now()): Promise<string> {
  const address = normalizeEmail(email);
  const token = randomBytes(32).toString("base64url");
  const db = getDb();
  await db.$transaction([
    db.verificationToken.deleteMany({ where: { identifier: address } }),
    db.verificationToken.create({
      data: {
        identifier: address,
        token: hashToken(token),
        expires: new Date(now + VERIFICATION_TTL_MS),
      },
    }),
  ]);
  await getMailer().send({
    to: address,
    subject: "Confirm your email address for CollabDocs",
    text: [
      "Confirm that this email address is yours by opening the link below.",
      "Until you do, document invitations sent to this address are held back.",
      "",
      `${appUrl()}/verify-email?token=${token}`,
      "",
      "The link works once and expires in 24 hours. If you did not create an account, ignore this message.",
    ].join("\n"),
  });
  return token;
}

/**
 * Turns invitations to this address into memberships. Called when the address has
 * been verified, in the same transaction, so a pending invitation is never both
 * kept and applied.
 */
export async function bindPendingInvites(
  tx: Prisma.TransactionClient,
  userId: string,
  email: string,
): Promise<number> {
  const invites = await tx.pendingInvite.findMany({ where: { email: normalizeEmail(email) } });
  if (invites.length === 0) return 0;
  await tx.membership.createMany({
    data: invites.map((invite) => ({
      documentId: invite.documentId,
      userId,
      role: invite.role,
    })),
    // Already a member (through an owner membership, say): keep that one.
    skipDuplicates: true,
  });
  await tx.pendingInvite.deleteMany({ where: { id: { in: invites.map((i) => i.id) } } });
  return invites.length;
}

export type VerifyResult = { ok: true; email: string } | { ok: false };

/**
 * Consumes a token: marks the account's address verified and binds the pending
 * invitations. A token is single use, and an expired or unknown one gives the same
 * answer.
 */
export async function verifyEmailToken(token: string, now = Date.now()): Promise<VerifyResult> {
  const db = getDb();
  return db.$transaction(async (tx) => {
    // deleteMany reports how many rows it removed, so two requests with the same token cannot both win.
    const row = await tx.verificationToken.findUnique({ where: { token: hashToken(token) } });
    if (!row) return { ok: false };
    const { count } = await tx.verificationToken.deleteMany({ where: { token: row.token } });
    if (count !== 1 || row.expires.getTime() <= now) return { ok: false };
    const user = await tx.user.findUnique({ where: { email: row.identifier } });
    if (!user) return { ok: false };
    await tx.user.update({
      where: { id: user.id },
      data: { emailVerified: user.emailVerified ?? new Date(now) },
    });
    await bindPendingInvites(tx, user.id, user.email);
    return { ok: true, email: user.email };
  });
}
