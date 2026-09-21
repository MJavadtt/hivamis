-- Pauses on SLA clocks (roadmap #9). The PAUSED state, pausedAt and pausedSeconds have existed
-- since 20260906230637 with no code path that set them; this adds the working-hour total the
-- arithmetic needs and the per-pause record the reporting needs.
--
-- (prisma migrate diff also proposed dropping cost_declarations_workorder_idx: that index comes
-- from a raw-SQL migration the datamodel does not describe. It stays.)

-- AlterTable
ALTER TABLE "sla_clocks" ADD COLUMN     "pausedHours" DECIMAL(8,2) NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "sla_pauses" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "clockId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "pausedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resumedAt" TIMESTAMP(3),
    "businessHours" DECIMAL(8,2),
    "pausedById" TEXT,
    "resumedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sla_pauses_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sla_pauses_clockId_idx" ON "sla_pauses"("clockId");

-- CreateIndex
CREATE INDEX "sla_pauses_organizationId_kind_idx" ON "sla_pauses"("organizationId", "kind");

-- AddForeignKey
ALTER TABLE "sla_pauses" ADD CONSTRAINT "sla_pauses_clockId_fkey" FOREIGN KEY ("clockId") REFERENCES "sla_clocks"("id") ON DELETE CASCADE ON UPDATE CASCADE;

