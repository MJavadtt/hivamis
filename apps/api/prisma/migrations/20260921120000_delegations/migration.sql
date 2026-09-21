-- Time-boxed delegation (roadmap #6), and the column that records when an actor held a
-- permission only through one: the audit trail says "A, as B's delegate", not just "A".

-- AlterTable
ALTER TABLE "audit_events" ADD COLUMN     "onBehalfOfId" TEXT;

-- AlterTable
ALTER TABLE "state_transitions" ADD COLUMN     "onBehalfOfId" TEXT;

-- CreateTable
CREATE TABLE "delegations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "fromUserId" TEXT NOT NULL,
    "toUserId" TEXT NOT NULL,
    "permissions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "roles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "startsAt" TIMESTAMP(3) NOT NULL,
    "endsAt" TIMESTAMP(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "delegations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "delegations_toUserId_startsAt_endsAt_idx" ON "delegations"("toUserId", "startsAt", "endsAt");

-- CreateIndex
CREATE INDEX "delegations_fromUserId_idx" ON "delegations"("fromUserId");

-- CreateIndex
CREATE INDEX "delegations_organizationId_idx" ON "delegations"("organizationId");


