import { ASSIGNABLE_ROLES, can } from "@collabdocs/shared";
import { z } from "zod";
import {
  handle,
  HttpError,
  json,
  noContent,
  readBody,
  requireRole,
  requireUser,
  type MemberContext,
} from "@/lib/api";
import { getDb } from "@/lib/db";
import { publishMembershipChange } from "@/lib/membership-events";

const changeSchema = z.object({ role: z.enum(ASSIGNABLE_ROLES) });

async function targetMembership(documentId: string, userId: string) {
  const target = await getDb().membership.findUnique({
    where: { documentId_userId: { documentId, userId } },
  });
  if (!target) throw new HttpError(404, "member_not_found", "This user is not a member");
  return target;
}

/** Change a member's role. Needs "change-role"; the owner's role cannot change. */
export const PATCH = handle(async (request: Request, { params }: MemberContext) => {
  const { id, userId } = await params;
  const user = await requireUser();
  await requireRole(id, user.id, "change-role");
  const { role } = await readBody(request, changeSchema);
  const target = await targetMembership(id, userId);
  if (target.role === "owner") {
    throw new HttpError(409, "owner_is_fixed", "The owner's role cannot be changed");
  }
  const updated = await getDb().membership.update({
    where: { documentId_userId: { documentId: id, userId } },
    data: { role },
  });
  await publishMembershipChange({ documentId: id, userId, change: "role-changed" });
  return json({ membership: { userId, role: updated.role } });
});

/**
 * Remove a member. Removing someone else needs "change-role" (the owner). Any
 * member except the owner may remove themselves, which is leaving.
 */
export const DELETE = handle(async (_request: Request, { params }: MemberContext) => {
  const { id, userId } = await params;
  const user = await requireUser();
  const role = await requireRole(id, user.id, "read");
  const leaving = userId === user.id;
  if (!leaving && !can(role, "change-role")) {
    throw new HttpError(403, "forbidden", "Your role does not allow this (change-role)");
  }
  const target = await targetMembership(id, userId);
  if (target.role === "owner") {
    throw new HttpError(
      409,
      "owner_is_fixed",
      "The owner cannot be removed; delete the document instead",
    );
  }
  await getDb().membership.delete({ where: { documentId_userId: { documentId: id, userId } } });
  await publishMembershipChange({ documentId: id, userId, change: "removed" });
  return noContent();
});
