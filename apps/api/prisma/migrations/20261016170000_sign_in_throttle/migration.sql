-- Audit SEC-10: wrong passwords and codes slow their network down instead of locking the account.

-- The account-wide counters go: five failures from anywhere no longer lock anyone out.
-- `lockedUntil` stays, for a lock someone sets on purpose.
ALTER TABLE "users" DROP COLUMN "failedLoginCount";
ALTER TABLE "portal_users" DROP COLUMN "failedLogins";

-- Throttle state per (what was typed, client network). Not evidence: LOGIN_FAILED stays in the audit trail.
CREATE TABLE "sign_in_failures" (
    "id" TEXT NOT NULL,
    "identifier" TEXT NOT NULL,
    "network" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "sign_in_failures_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "sign_in_failures_identifier_network_createdAt_idx" ON "sign_in_failures"("identifier", "network", "createdAt");
CREATE INDEX "sign_in_failures_createdAt_idx" ON "sign_in_failures"("createdAt");
