import { createHash, randomBytes } from "node:crypto";
import { can } from "@collabdocs/shared";
import type { Prisma } from "@prisma/client";
import { getDb } from "./db";
import { normalizeEmail } from "./email";
import { getMailer } from "./mailer";

export const VERIFICATION_TTL_MS = 24 * 60 * 60 * 1000;

/** The database holds only the hash: a copy of the table cannot be used to verify anyone. */
function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The public URL of the app: AUTH_URL; in development only, http://localhost:3000 when it is unset. */
export function appUrl(env: Record<string, string | undefined> = process.env): string {
  const url = env.AUTH_URL || (env.NODE_ENV === "production" ? "" : "http://localhost:3000");
  if (!url) throw new Error("AUTH_URL is required in production");
  return url.replace(/\/+$/, "");
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
 * The database work of `sendVerificationEmail` without its effect: a token row is written
 * and removed again, in the same two statements and one transaction. Registering an
 * address that already has an account runs this, so that it takes the same time as
 * registering a new one and the response does not say which it was. The identifier is
 * one no address can have, so it never touches a real token.
 */
export async function matchVerificationWrite(email: string, now = Date.now()): Promise<void> {
  const identifier = `decoy:${normalizeEmail(email)}`;
  const db = getDb();
  await db.$transaction([
    db.verificationToken.create({
      data: {
        identifier,
        token: hashToken(randomBytes(32).toString("base64url")),
        expires: new Date(now + VERIFICATION_TTL_MS),
      },
    }),
    db.verificationToken.deleteMany({ where: { identifier } }),
  ]);
}

/**
 * Turns invitations to this address into memberships. Called when the address has
 * been verified, in the same transaction, so a pending invitation is never both
 * kept and applied.
 *
 * An invitation binds only if the member who sent it may still share at this
 * moment: an inviter who was removed, or demoted to a role that cannot share, in the
 * meantime must not be able to grant access through an invitation left behind. Such
 * an invitation is deleted and the fact is logged. `documentId` limits the binding to
 * one document.
 */
export async function bindPendingInvites(
  tx: Prisma.TransactionClient,
  userId: string,
  email: string,
  documentId?: string,
): Promise<number> {
  const invites = await tx.pendingInvite.findMany({
    where: { email: normalizeEmail(email), ...(documentId ? { documentId } : {}) },
    orderBy: { createdAt: "asc" },
  });
  if (invites.length === 0) return 0;
  // Per document, the oldest invitation whose inviter may still share decides the role.
  const bind = new Map<string, (typeof invites)[number]>();
  for (const invite of invites) {
    const inviter = await tx.membership.findUnique({
      where: { documentId_userId: { documentId: invite.documentId, userId: invite.invitedById } },
      select: { role: true },
    });
    if (inviter && can(inviter.role, "share")) {
      if (!bind.has(invite.documentId)) bind.set(invite.documentId, invite);
    } else {
      console.warn("dropped a pending invitation: its inviter may no longer share", {
        documentId: invite.documentId,
        inviteId: invite.id,
        inviterId: invite.invitedById,
        inviterRole: inviter?.role ?? null,
      });
    }
  }
  if (bind.size > 0) {
    await tx.membership.createMany({
      data: [...bind.values()].map((invite) => ({
        documentId: invite.documentId,
        userId,
        role: invite.role,
      })),
      // Already a member (through an owner membership, say): keep that one.
      skipDuplicates: true,
    });
  }
  await tx.pendingInvite.deleteMany({ where: { id: { in: invites.map((i) => i.id) } } });
  return bind.size;
}

/**
 * Sent when someone registers an address that already has an account. The answer to the
 * person at the keyboard is the same as for a new address; this is what the owner of the
 * address learns, in their own inbox. It carries no token and nothing that signs in.
 */
export async function sendAccountExistsEmail(email: string): Promise<void> {
  await getMailer().send({
    to: normalizeEmail(email),
    subject: "You already have a CollabDocs account",
    text: [
      "Someone tried to create a CollabDocs account with this email address, but you already have an account.",
      "",
      `If it was you, sign in at ${appUrl()}/sign-in instead. If you do not remember your password, note that password reset is not available yet.`,
      "",
      "If it was not you, ignore this message: nothing has changed.",
    ].join("\n"),
  });
}

/**
 * Applies the invitations held for a user whose address is verified: what an invitation
 * to a registered address becomes when its owner next opens the app. Doing it here, and
 * not when the invitation is sent, keeps the answer to the inviter the same for every
 * address. A user whose address is not verified gets nothing.
 */
export async function bindInvitesFor(userId: string, documentId?: string): Promise<number> {
  const db = getDb();
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { email: true, emailVerified: true },
  });
  if (!user?.emailVerified) return 0;
  const waiting = await db.pendingInvite.count({
    where: { email: user.email, ...(documentId ? { documentId } : {}) },
  });
  if (waiting === 0) return 0;
  return db.$transaction((tx) => bindPendingInvites(tx, userId, user.email, documentId));
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
