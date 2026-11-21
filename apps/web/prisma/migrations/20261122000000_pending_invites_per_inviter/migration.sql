-- An invitation belongs to the member who sent it: one row per (document, address, inviter),
-- so that a second inviter neither takes over the first one's row nor loses it when the
-- other is removed.

-- DropIndex
DROP INDEX "PendingInvite_documentId_email_key";

-- CreateIndex
CREATE UNIQUE INDEX "PendingInvite_documentId_email_invitedById_key" ON "PendingInvite"("documentId", "email", "invitedById");
