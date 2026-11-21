import { signCollabToken } from "@collabdocs/shared";
import { handle, json, requireRole, requireUser, type DocumentContext } from "@/lib/api";
import { collabTokenConfig } from "@/lib/collab-token";
import { displayName } from "@/lib/collab/identity";

/**
 * A token that lets the caller open this document on the collab server, with
 * the role they hold now and the name other people see for them. Any member may ask (it needs "read"); a non-member
 * gets 404. The token lives for minutes, so a changed role takes effect when
 * the token is next refreshed, and the collab server also drops live
 * connections when a membership changes.
 */
export const POST = handle(async (_request: Request, { params }: DocumentContext) => {
  const { id } = await params;
  const user = await requireUser();
  const role = await requireRole(id, user.id, "read");
  const { secret, ttlSeconds } = collabTokenConfig();
  const { token, expiresAt } = await signCollabToken({
    documentId: id,
    userId: user.id,
    role,
    // The collab server shows this name next to the user's cursor, whatever the client announces.
    name: displayName(user),
    secret,
    ttlSeconds,
  });
  return json({ token, expiresAt, role });
});
