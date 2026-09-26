-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "proposalId" TEXT;

-- CreateTable
CREATE TABLE "client_approvals" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "subjectState" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "contactId" TEXT,
    "contactName" TEXT NOT NULL,
    "contactEmail" TEXT NOT NULL,
    "message" TEXT,
    "manifest" JSONB NOT NULL,
    "manifestHash" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "requestedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "codeHash" TEXT,
    "codeExpiresAt" TIMESTAMP(3),
    "codeAttempts" INTEGER NOT NULL DEFAULT 0,
    "codesSent" INTEGER NOT NULL DEFAULT 0,
    "decision" TEXT,
    "comment" TEXT,
    "signerName" TEXT,
    "verification" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decidedIp" TEXT,
    "decidedUserAgent" TEXT,
    "sequence" INTEGER,
    "prevEvidenceHash" TEXT,
    "evidence" JSONB,
    "evidenceHash" TEXT,
    "transitionError" TEXT,
    "cancelledAt" TIMESTAMP(3),
    "cancelledById" TEXT,
    "cancelReason" TEXT,

    CONSTRAINT "client_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "client_approval_events" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "approvalId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "documentId" TEXT,
    "ip" TEXT,
    "userAgent" TEXT,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "client_approval_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "client_approvals_code_key" ON "client_approvals"("code");

-- CreateIndex
CREATE UNIQUE INDEX "client_approvals_tokenHash_key" ON "client_approvals"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "client_approvals_evidenceHash_key" ON "client_approvals"("evidenceHash");

-- CreateIndex
CREATE INDEX "client_approvals_subjectType_subjectId_idx" ON "client_approvals"("subjectType", "subjectId");

-- CreateIndex
CREATE INDEX "client_approvals_organizationId_status_idx" ON "client_approvals"("organizationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "client_approvals_organizationId_sequence_key" ON "client_approvals"("organizationId", "sequence");

-- CreateIndex
CREATE INDEX "client_approval_events_approvalId_at_idx" ON "client_approval_events"("approvalId", "at");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "proposals"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_approvals" ADD CONSTRAINT "client_approvals_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_approvals" ADD CONSTRAINT "client_approvals_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "contacts"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_approvals" ADD CONSTRAINT "client_approvals_requestedById_fkey" FOREIGN KEY ("requestedById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "client_approval_events" ADD CONSTRAINT "client_approval_events_approvalId_fkey" FOREIGN KEY ("approvalId") REFERENCES "client_approvals"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Roadmap #35: what a request is about, and a decision present exactly when it is sealed.
ALTER TABLE "client_approvals" ADD CONSTRAINT "client_approvals_subject_type" CHECK ("subjectType" IN ('DELIVERABLE', 'PROPOSAL'));
ALTER TABLE "client_approvals" ADD CONSTRAINT "client_approvals_decision" CHECK ("decision" IS NULL OR "decision" IN ('APPROVE', 'REQUEST_CHANGES'));
ALTER TABLE "client_approvals" ADD CONSTRAINT "client_approvals_sealed_iff_decided" CHECK (("decision" IS NULL) = ("evidenceHash" IS NULL));

-- A sealed approval is evidence: what was shown, who decided, when, from where and the chain link
-- do not change afterwards. Only the note that the decision could not be applied may be written.
CREATE FUNCTION client_approvals_sealed() RETURNS trigger AS $$
BEGIN
  IF OLD."evidenceHash" IS NOT NULL AND (
       NEW."evidenceHash" IS DISTINCT FROM OLD."evidenceHash" OR NEW."evidence" IS DISTINCT FROM OLD."evidence"
    OR NEW."decision" IS DISTINCT FROM OLD."decision" OR NEW."comment" IS DISTINCT FROM OLD."comment"
    OR NEW."signerName" IS DISTINCT FROM OLD."signerName" OR NEW."verification" IS DISTINCT FROM OLD."verification"
    OR NEW."decidedAt" IS DISTINCT FROM OLD."decidedAt" OR NEW."decidedIp" IS DISTINCT FROM OLD."decidedIp"
    OR NEW."decidedUserAgent" IS DISTINCT FROM OLD."decidedUserAgent" OR NEW."sequence" IS DISTINCT FROM OLD."sequence"
    OR NEW."prevEvidenceHash" IS DISTINCT FROM OLD."prevEvidenceHash" OR NEW."manifest" IS DISTINCT FROM OLD."manifest"
    OR NEW."manifestHash" IS DISTINCT FROM OLD."manifestHash" OR NEW."status" IS DISTINCT FROM OLD."status"
    OR NEW."contactName" IS DISTINCT FROM OLD."contactName" OR NEW."contactEmail" IS DISTINCT FROM OLD."contactEmail"
  ) THEN
    RAISE EXCEPTION 'client approval % is sealed', OLD."code" USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER "client_approvals_sealed" BEFORE UPDATE ON "client_approvals" FOR EACH ROW EXECUTE FUNCTION client_approvals_sealed();

-- The log is appended to, never rewritten.
CREATE FUNCTION client_approval_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'client approval events are append-only' USING ERRCODE = 'check_violation';
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER "client_approval_events_append_only" BEFORE UPDATE ON "client_approval_events" FOR EACH ROW EXECUTE FUNCTION client_approval_events_append_only();
