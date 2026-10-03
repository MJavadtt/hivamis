-- Hivamis task 2: a lead's source in two steps — the kind, then exactly who or what.


-- AlterTable
ALTER TABLE "leads" ADD COLUMN     "sourceChannel" TEXT,
ADD COLUMN     "sourceReferrerId" TEXT,
ADD COLUMN     "sourceUserId" TEXT;

-- CreateTable
CREATE TABLE "lead_referrers" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "phone" TEXT,
    "note" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "lead_referrers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "lead_referrers_organizationId_kind_name_key" ON "lead_referrers"("organizationId", "kind", "name");

-- CreateIndex
CREATE INDEX "leads_organizationId_phone_idx" ON "leads"("organizationId", "phone");

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_sourceUserId_fkey" FOREIGN KEY ("sourceUserId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "leads" ADD CONSTRAINT "leads_sourceReferrerId_fkey" FOREIGN KEY ("sourceReferrerId") REFERENCES "lead_referrers"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- The single-step sources leads had, in two steps (packages/contracts/src/crm.ts, LEGACY_LEAD_SOURCES):
-- a cold call was a seller's, events and campaigns are direct channels, the rest keep their kind
-- without the name nobody recorded.
UPDATE "leads" SET "sourceUserId" = "ownerId" WHERE "source" = 'OUTBOUND';
UPDATE "leads" SET "sourceChannel" = "source" WHERE "source" IN ('EVENT', 'CAMPAIGN');
UPDATE "leads" SET "source" = CASE "source"
  WHEN 'REFERRAL' THEN 'PARTNER'
  WHEN 'OUTBOUND' THEN 'SALES_TEAM'
  ELSE 'DIRECT'
END
WHERE "source" NOT IN ('SALES_TEAM', 'MARKETER', 'STAFF', 'DIRECT', 'PARTNER');

-- One kind of source, and only the detail that kind has.
ALTER TABLE "leads" ADD CONSTRAINT "leads_source_check" CHECK ("source" IN ('SALES_TEAM', 'MARKETER', 'STAFF', 'DIRECT', 'PARTNER'));
ALTER TABLE "leads" ADD CONSTRAINT "leads_source_channel_check" CHECK ("sourceChannel" IS NULL OR "sourceChannel" IN ('PHONE', 'EXHIBITION', 'EVENT', 'CAMPAIGN'));
ALTER TABLE "leads" ADD CONSTRAINT "leads_source_channel_direct" CHECK ("sourceChannel" IS NULL OR "source" = 'DIRECT');
ALTER TABLE "leads" ADD CONSTRAINT "leads_source_user_people" CHECK ("sourceUserId" IS NULL OR "source" IN ('SALES_TEAM', 'STAFF'));
ALTER TABLE "leads" ADD CONSTRAINT "leads_source_referrer_list" CHECK ("sourceReferrerId" IS NULL OR "source" IN ('MARKETER', 'PARTNER'));
ALTER TABLE "lead_referrers" ADD CONSTRAINT "lead_referrers_kind_check" CHECK ("kind" IN ('MARKETER', 'PARTNER'));
