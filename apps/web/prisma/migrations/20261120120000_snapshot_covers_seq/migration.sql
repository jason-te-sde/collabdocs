-- A snapshot records the highest update sequence number it contains, so that
-- sequence numbers keep increasing after compaction has trimmed the log.
ALTER TABLE "DocumentSnapshot" ADD COLUMN "upToSeq" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "DocumentSnapshot"
  ADD CONSTRAINT "DocumentSnapshot_upToSeq_nonnegative" CHECK ("upToSeq" >= 0);
