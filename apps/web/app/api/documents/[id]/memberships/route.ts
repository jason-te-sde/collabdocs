import { ASSIGNABLE_ROLES } from "@collabdocs/shared";
import { z } from "zod";
import {
  handle,
  HttpError,
  json,
  readBody,
  requireRole,
  requireUser,
  type DocumentContext,
} from "@/lib/api";
import { getDb, isUniqueViolation } from "@/lib/db";
import { normalizeEmail } from "@/lib/email";

const inviteSchema = z.object({
  email: z.email().max(254),
  // "owner" is not assignable: a document has one owner, its creator.
  role: z.enum(ASSIGNABLE_ROLES),
});

export const GET = handle(async (_request: Request, { params }: DocumentContext) => {
  const { id } = await params;
  const user = await requireUser();
  await requireRole(id, user.id, "read");
  const members = await getDb().membership.findMany({
    where: { documentId: id },
    include: { user: { select: { id: true, email: true, name: true } } },
    orderBy: { createdAt: "asc" },
  });
  const invitations = await getDb().pendingInvite.findMany({
    where: { documentId: id },
    orderBy: { createdAt: "asc" },
  });
  return json({
    memberships: members.map((m) => ({
      userId: m.userId,
      email: m.user.email,
      name: m.user.name,
      role: m.role,
    })),
    // Invitations to addresses whose account has not verified them yet.
    invitations: invitations.map((i) => ({ id: i.id, email: i.email, role: i.role })),
  });
});

/**
 * Invite a registered user by email. Needs the "share" right. An invitation grants
 * access only to an address its account has verified: otherwise anyone could register
 * a stranger's address and receive what was meant for them. An unverified account
 * gets a pending invitation (202), which becomes a membership when it verifies.
 */
export const POST = handle(async (request: Request, { params }: DocumentContext) => {
  const { id } = await params;
  const user = await requireUser();
  await requireRole(id, user.id, "share");
  const body = await readBody(request, inviteSchema);
  const db = getDb();
  const invitee = await db.user.findUnique({
    where: { email: normalizeEmail(body.email) },
    select: { id: true, email: true, name: true, emailVerified: true },
  });
  if (!invitee) throw new HttpError(404, "user_not_found", "No registered user has this email");
  if (!invitee.emailVerified) {
    const member = await db.membership.findUnique({
      where: { documentId_userId: { documentId: id, userId: invitee.id } },
      select: { id: true },
    });
    if (member) throw new HttpError(409, "already_member", "This user is already a member");
    const invitation = await db.pendingInvite.upsert({
      where: { documentId_email: { documentId: id, email: invitee.email } },
      create: { documentId: id, email: invitee.email, role: body.role, invitedById: user.id },
      update: { role: body.role, invitedById: user.id },
    });
    return json(
      { invitation: { id: invitation.id, email: invitation.email, role: invitation.role } },
      202,
    );
  }
  try {
    const membership = await db.membership.create({
      data: { documentId: id, userId: invitee.id, role: body.role },
    });
    return json(
      {
        membership: {
          userId: invitee.id,
          email: invitee.email,
          name: invitee.name,
          role: membership.role,
        },
      },
      201,
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new HttpError(409, "already_member", "This user is already a member");
    }
    throw error;
  }
});
