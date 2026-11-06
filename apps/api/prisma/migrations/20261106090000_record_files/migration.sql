-- A file on any record (ADR-121).
ALTER TABLE "documents" ADD COLUMN "recordType" TEXT;
ALTER TABLE "documents" ADD COLUMN "recordId" TEXT;
CREATE INDEX "documents_organizationId_recordType_recordId_idx" ON "documents"("organizationId", "recordType", "recordId");
