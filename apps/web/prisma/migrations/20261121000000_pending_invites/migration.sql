-- CreateTable
CREATE TABLE "PendingInvite" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "invitedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PendingInvite_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "PendingInvite_email_idx" ON "PendingInvite"("email");

-- CreateIndex
CREATE UNIQUE INDEX "PendingInvite_documentId_email_key" ON "PendingInvite"("documentId", "email");

-- AddForeignKey
ALTER TABLE "PendingInvite" ADD CONSTRAINT "PendingInvite_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PendingInvite" ADD CONSTRAINT "PendingInvite_invitedById_fkey" FOREIGN KEY ("invitedById") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Invariants that the Prisma schema language cannot express.
-- ---------------------------------------------------------------------------

-- Like User.email, an invited address is stored lower-case, so that it matches.
ALTER TABLE "PendingInvite"
  ADD CONSTRAINT "PendingInvite_email_lowercase" CHECK ("email" = lower("email"));

-- A document has one owner, its creator: nobody is invited as owner.
ALTER TABLE "PendingInvite"
  ADD CONSTRAINT "PendingInvite_not_owner" CHECK ("role" <> 'owner');
