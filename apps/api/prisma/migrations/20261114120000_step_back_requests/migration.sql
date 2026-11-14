-- ADR-128: a record taken back a step to be corrected, with its manager's approval.
CREATE TABLE "step_back_requests" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "fromState" TEXT NOT NULL,
    "toState" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "requestedById" TEXT NOT NULL,
    "approverId" TEXT,
    "state" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "step_back_requests_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "step_back_requests_organizationId_state_idx" ON "step_back_requests"("organizationId", "state");
CREATE INDEX "step_back_requests_entityType_entityId_idx" ON "step_back_requests"("entityType", "entityId");
CREATE INDEX "step_back_requests_approverId_state_idx" ON "step_back_requests"("approverId", "state");
ALTER TABLE "step_back_requests" ADD CONSTRAINT "step_back_requests_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "step_back_requests" ADD CONSTRAINT "step_back_requests_approverId_fkey" FOREIGN KEY ("approverId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "step_back_requests" ADD CONSTRAINT "step_back_requests_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
