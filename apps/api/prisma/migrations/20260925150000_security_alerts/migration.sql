-- Anomalies on the audit trail (roadmap #26): the same data, raised while it can still matter.
CREATE TABLE "security_alerts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "severity" TEXT NOT NULL,
    "actorId" TEXT,
    "ipAddress" TEXT,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "evidence" JSONB NOT NULL,
    "messageFa" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'OPEN',
    "reviewedById" TEXT,
    "reviewedAt" TIMESTAMP(3),
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "security_alerts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "security_alerts_organizationId_fingerprint_key" ON "security_alerts"("organizationId", "fingerprint");
CREATE INDEX "security_alerts_organizationId_status_createdAt_idx" ON "security_alerts"("organizationId", "status", "createdAt");
ALTER TABLE "security_alerts" ADD CONSTRAINT "security_alerts_status_check" CHECK ("status" IN ('OPEN', 'ACKNOWLEDGED', 'DISMISSED'));
ALTER TABLE "security_alerts" ADD CONSTRAINT "security_alerts_severity_check" CHECK ("severity" IN ('INFO', 'MEDIUM', 'HIGH', 'CRITICAL'));
