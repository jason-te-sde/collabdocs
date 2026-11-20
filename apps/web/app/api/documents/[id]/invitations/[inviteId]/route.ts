import { handle, HttpError, noContent, requireRole, requireUser } from "@/lib/api";
import { getDb } from "@/lib/db";

type InvitationContext = { params: Promise<{ id: string; inviteId: string }> };

/** Withdraws a pending invitation. Needs the same right as removing a member. */
export const DELETE = handle(async (_request: Request, { params }: InvitationContext) => {
  const { id, inviteId } = await params;
  const user = await requireUser();
  await requireRole(id, user.id, "change-role");
  // Scoped to the document in the URL: an id from another document is not found.
  const { count } = await getDb().pendingInvite.deleteMany({
    where: { id: inviteId, documentId: id },
  });
  if (count === 0) throw new HttpError(404, "not_found", "Invitation not found");
  return noContent();
});
