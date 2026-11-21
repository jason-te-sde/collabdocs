import { handle, HttpError, noContent, requireRole, requireUser } from "@/lib/api";
import { getDb } from "@/lib/db";

type InvitationContext = { params: Promise<{ id: string; inviteId: string }> };

/** Withdraws a pending invitation. Needs the same right as removing a member. */
export const DELETE = handle(async (_request: Request, { params }: InvitationContext) => {
  const { id, inviteId } = await params;
  const user = await requireUser();
  await requireRole(id, user.id, "change-role");
  // Scoped to the document in the URL: an id from another document is not found.
  const invitation = await getDb().pendingInvite.findFirst({
    where: { id: inviteId, documentId: id },
    select: { email: true },
  });
  if (!invitation) throw new HttpError(404, "not_found", "Invitation not found");
  // The list shows one entry per address, so withdrawing it withdraws every member's invitation to it.
  await getDb().pendingInvite.deleteMany({ where: { documentId: id, email: invitation.email } });
  return noContent();
});
