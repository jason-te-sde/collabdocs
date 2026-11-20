-- CreateEnum
CREATE TYPE "Role" AS ENUM ('owner', 'editor', 'viewer');

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "name" TEXT,
    "email" TEXT NOT NULL,
    "emailVerified" TIMESTAMP(3),
    "image" TEXT,
    "passwordHash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Account" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerAccountId" TEXT NOT NULL,
    "refresh_token" TEXT,
    "access_token" TEXT,
    "expires_at" INTEGER,
    "token_type" TEXT,
    "scope" TEXT,
    "id_token" TEXT,
    "session_state" TEXT,

    CONSTRAINT "Account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Session" (
    "id" TEXT NOT NULL,
    "sessionToken" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationToken" (
    "identifier" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "expires" TIMESTAMP(3) NOT NULL
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Membership" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" "Role" NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Membership_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentSnapshot" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "state" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentSnapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentUpdate" (
    "id" BIGSERIAL NOT NULL,
    "documentId" TEXT NOT NULL,
    "seq" BIGINT NOT NULL,
    "data" BYTEA NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentUpdate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");

-- CreateIndex
CREATE INDEX "Account_userId_idx" ON "Account"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON "Account"("provider", "providerAccountId");

-- CreateIndex
CREATE UNIQUE INDEX "Session_sessionToken_key" ON "Session"("sessionToken");

-- CreateIndex
CREATE INDEX "Session_userId_idx" ON "Session"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_token_key" ON "VerificationToken"("token");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationToken_identifier_token_key" ON "VerificationToken"("identifier", "token");

-- CreateIndex
CREATE INDEX "Document_ownerId_idx" ON "Document"("ownerId");

-- CreateIndex
CREATE INDEX "Membership_userId_idx" ON "Membership"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "Membership_documentId_userId_key" ON "Membership"("documentId", "userId");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentSnapshot_documentId_version_key" ON "DocumentSnapshot"("documentId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "DocumentUpdate_documentId_seq_key" ON "DocumentUpdate"("documentId", "seq");

-- AddForeignKey
ALTER TABLE "Account" ADD CONSTRAINT "Account_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Membership" ADD CONSTRAINT "Membership_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentSnapshot" ADD CONSTRAINT "DocumentSnapshot_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentUpdate" ADD CONSTRAINT "DocumentUpdate_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Invariants that the Prisma schema language cannot express.
-- ---------------------------------------------------------------------------

-- Emails are stored lower-case, so the unique index is case-insensitive.
ALTER TABLE "User"
  ADD CONSTRAINT "User_email_lowercase" CHECK ("email" = lower("email"));

-- A title is never empty and never longer than 200 characters.
ALTER TABLE "Document"
  ADD CONSTRAINT "Document_title_length" CHECK (char_length("title") BETWEEN 1 AND 200);

-- Sequence numbers and versions start at 1.
ALTER TABLE "DocumentUpdate"
  ADD CONSTRAINT "DocumentUpdate_seq_positive" CHECK ("seq" >= 1);
ALTER TABLE "DocumentSnapshot"
  ADD CONSTRAINT "DocumentSnapshot_version_positive" CHECK ("version" >= 1);

-- At most one owner membership per document.
CREATE UNIQUE INDEX "Membership_one_owner_per_document"
  ON "Membership" ("documentId") WHERE "role" = 'owner';

-- An owner membership belongs to the user named by Document.ownerId, and an
-- owner membership is never changed or deleted while its document exists
-- (deleting the document cascades to it, and that is allowed).
CREATE FUNCTION "membership_owner_guard"() RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('INSERT', 'UPDATE') AND NEW."role" = 'owner' THEN
    IF NEW."userId" IS DISTINCT FROM
       (SELECT d."ownerId" FROM "Document" d WHERE d."id" = NEW."documentId") THEN
      RAISE EXCEPTION 'owner membership must belong to the document owner'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP IN ('UPDATE', 'DELETE') AND OLD."role" = 'owner'
     AND EXISTS (SELECT 1 FROM "Document" d WHERE d."id" = OLD."documentId") THEN
    IF TG_OP = 'DELETE'
       OR NEW."role" <> 'owner'
       OR NEW."userId" <> OLD."userId"
       OR NEW."documentId" <> OLD."documentId" THEN
      RAISE EXCEPTION 'the owner membership of a document cannot be changed or removed'
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Membership_owner_guard"
  BEFORE INSERT OR UPDATE OR DELETE ON "Membership"
  FOR EACH ROW EXECUTE FUNCTION "membership_owner_guard"();

-- Every document has its owner membership by the end of the transaction that
-- creates it.
CREATE FUNCTION "document_requires_owner_membership"() RETURNS trigger AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "Membership" m
    WHERE m."documentId" = NEW."id" AND m."role" = 'owner' AND m."userId" = NEW."ownerId"
  ) THEN
    RAISE EXCEPTION 'a document needs an owner membership for its owner'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER "Document_requires_owner_membership"
  AFTER INSERT ON "Document"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION "document_requires_owner_membership"();

-- The owner of a document cannot be changed in place.
CREATE FUNCTION "document_owner_immutable"() RETURNS trigger AS $$
BEGIN
  IF NEW."ownerId" <> OLD."ownerId" THEN
    RAISE EXCEPTION 'the owner of a document cannot be changed'
      USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "Document_owner_immutable"
  BEFORE UPDATE ON "Document"
  FOR EACH ROW EXECUTE FUNCTION "document_owner_immutable"();

-- The update log is append-only. Compaction deletes rows it has folded into a
-- snapshot; nothing rewrites one.
CREATE FUNCTION "document_update_append_only"() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'DocumentUpdate rows are append-only'
    USING ERRCODE = 'check_violation';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "DocumentUpdate_append_only"
  BEFORE UPDATE ON "DocumentUpdate"
  FOR EACH ROW EXECUTE FUNCTION "document_update_append_only"();
