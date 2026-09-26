-- AlterTable
ALTER TABLE "milestones" ADD COLUMN     "revenueShare" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "revenueMethod" TEXT NOT NULL DEFAULT 'EFFORT';

-- CreateTable
CREATE TABLE "revenue_entries" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "method" TEXT NOT NULL,
    "progress" DECIMAL(7,6) NOT NULL,
    "contractValue" DECIMAL(20,2) NOT NULL,
    "recognisedToDate" DECIMAL(20,2) NOT NULL,
    "amount" DECIMAL(20,2) NOT NULL,
    "invoicedToDate" DECIMAL(20,2) NOT NULL,
    "basis" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "revenue_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "revenue_periods" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "period" TEXT NOT NULL,
    "periodStart" TIMESTAMP(3) NOT NULL,
    "periodEnd" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "closedById" TEXT NOT NULL,
    "totals" JSONB NOT NULL,

    CONSTRAINT "revenue_periods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "revenue_entries_organizationId_period_idx" ON "revenue_entries"("organizationId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_entries_projectId_period_key" ON "revenue_entries"("projectId", "period");

-- CreateIndex
CREATE UNIQUE INDEX "revenue_periods_organizationId_period_key" ON "revenue_periods"("organizationId", "period");

-- AddForeignKey
ALTER TABLE "revenue_entries" ADD CONSTRAINT "revenue_entries_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- The three ways revenue is earned, a share of work between none and all, a share of a contract
-- between nothing and all of it.
ALTER TABLE "projects" ADD CONSTRAINT "projects_revenue_method_check" CHECK ("revenueMethod" IN ('MILESTONE', 'EFFORT', 'COST'));
ALTER TABLE "revenue_entries" ADD CONSTRAINT "revenue_entries_progress_range" CHECK ("progress" >= 0 AND "progress" <= 1);
ALTER TABLE "milestones" ADD CONSTRAINT "milestones_revenue_share_range" CHECK ("revenueShare" IS NULL OR ("revenueShare" >= 0 AND "revenueShare" <= 100));
