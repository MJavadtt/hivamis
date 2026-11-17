-- A note on any record may carry files (ADR-134).
ALTER TABLE "comments" ADD COLUMN "documentIds" TEXT[] DEFAULT ARRAY[]::TEXT[];
