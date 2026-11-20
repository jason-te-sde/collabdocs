import { randomUUID } from "node:crypto";
import { ASSIGNABLE_ROLES } from "@collabdocs/shared";
import { z } from "zod";
import { handle, json, readBody, requireRole, requireUser, type DocumentContext } from "@/lib/api";
import { getDb } from "@/lib/db";
import { normalizeEmail } from "@/lib/email";
import { sendInvitationEmail } from "@/lib/invitations";
import { enforceInviteLimit } from "@/lib/rate-limit";

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
    // Held until the address is verified and its owner opens the app.
    invitations: invitations.map((i) => ({ id: i.id, email: i.email, role: i.role })),
  });
});

/**
 * Invite an address. Needs the "share" right. The answer is the same for every address:
 * 202 and the invitation, whether or not an account has the address, is verified, or is
 * a member already. Otherwise this route would tell anyone who may share which addresses
 * are registered, and which of those are verified. The invitation is held, and the
 * details go to the address by email. It becomes a membership when the address is
 * verified and its owner next opens the app (`bindInvitesFor`), if the inviter may still
 * share then. The route is rate limited per user and per address.
 */
export const POST = handle(async (request: Request, { params }: DocumentContext) => {
  const { id } = await params;
  const user = await requireUser();
  await requireRole(id, user.id, "share");
  const body = await readBody(request, inviteSchema);
  const email = normalizeEmail(body.email);
  await enforceInviteLimit(user.id, email);
  const db = getDb();
  const [invitee, document, inviter] = await Promise.all([
    db.user.findUnique({ where: { email }, select: { id: true } }),
    db.document.findUniqueOrThrow({ where: { id }, select: { title: true } }),
    db.user.findUniqueOrThrow({ where: { id: user.id }, select: { name: true, email: true } }),
  ]);
  const member = invitee
    ? await db.membership.findUnique({
        where: { documentId_userId: { documentId: id, userId: invitee.id } },
        select: { id: true },
      })
    : null;
  let invitationId: string;
  if (member) {
    // Nothing to hold, and nothing to say: the same answer, with an id that matches no row.
    invitationId = randomUUID();
  } else {
    const invitation = await db.pendingInvite.upsert({
      where: { documentId_email: { documentId: id, email } },
      create: { documentId: id, email, role: body.role, invitedById: user.id },
      update: { role: body.role, invitedById: user.id },
    });
    invitationId = invitation.id;
    try {
      await sendInvitationEmail({
        to: email,
        documentTitle: document.title,
        inviter: inviter.name ?? inviter.email,
        role: body.role,
        hasAccount: invitee !== null,
      });
    } catch (error) {
      // The invitation stands; a failed mail must not make the answer differ.
      console.error("could not send the invitation email", error);
    }
  }
  return json({ invitation: { id: invitationId, email, role: body.role } }, 202);
});
