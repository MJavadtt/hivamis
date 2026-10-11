-- Audit LOG-5: deleted documents' files are removed after a retention period, unless held; each
-- organisation may be given a storage quota.
ALTER TABLE "documents" ADD COLUMN "legalHold" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "legalHoldReason" TEXT,
ADD COLUMN "purgedAt" TIMESTAMP(3);
ALTER TABLE "documents" ADD CONSTRAINT "documents_hold_reason" CHECK (NOT "legalHold" OR "legalHoldReason" IS NOT NULL);
CREATE INDEX "documents_purge_idx" ON "documents" ("deletedAt") WHERE "deletedAt" IS NOT NULL AND "purgedAt" IS NULL;

ALTER TABLE "organizations" ADD COLUMN "storageQuotaMb" INTEGER;
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_storage_quota" CHECK ("storageQuotaMb" IS NULL OR "storageQuotaMb" > 0);
