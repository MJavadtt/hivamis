-- Governed waivers (roadmap #7): an exception to one guard on one record, once, with a reason,
-- an expiry and a register.

-- CreateTable
CREATE TABLE "waivers" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "guard" TEXT NOT NULL,
    "action" TEXT,
    "reason" TEXT NOT NULL,
    "grantedById" TEXT NOT NULL,
    "grantedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "usedById" TEXT,
    "usedAction" TEXT,
    "revokedAt" TIMESTAMP(3),
    "revokedById" TEXT,

    CONSTRAINT "waivers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "waivers_organizationId_entityType_entityId_idx" ON "waivers"("organizationId", "entityType", "entityId");

-- CreateIndex
CREATE INDEX "waivers_organizationId_expiresAt_idx" ON "waivers"("organizationId", "expiresAt");


