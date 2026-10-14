-- Audit F-4: what the assistant proposed to do, and what the person approved of it.
CREATE TABLE "ai_plans" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "conversationId" TEXT,
    "steps" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "outcome" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "decidedAt" TIMESTAMP(3),

    CONSTRAINT "ai_plans_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "ai_plans_status_check" CHECK ("status" IN ('PROPOSED', 'EXECUTED', 'PARTIAL', 'FAILED', 'DECLINED'))
);
CREATE INDEX "ai_plans_userId_createdAt_idx" ON "ai_plans"("userId", "createdAt");
ALTER TABLE "ai_plans" ADD CONSTRAINT "ai_plans_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ai_plans" ADD CONSTRAINT "ai_plans_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
