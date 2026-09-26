-- CreateTable
CREATE TABLE "signature_envelopes" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "contractId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerRef" TEXT,
    "status" TEXT NOT NULL DEFAULT 'SENT',
    "documentId" TEXT NOT NULL,
    "originalSha256" TEXT NOT NULL,
    "signedDocumentId" TEXT,
    "signedSha256" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,
    "transitionError" TEXT,

    CONSTRAINT "signature_envelopes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_signers" (
    "id" TEXT NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "order" INTEGER NOT NULL,
    "party" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "contactId" TEXT,
    "userId" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "signedAt" TIMESTAMP(3),
    "declineReason" TEXT,
    "certificate" JSONB,
    "ip" TEXT,
    "tokenHash" TEXT,

    CONSTRAINT "signature_signers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signature_events" (
    "id" TEXT NOT NULL,
    "seq" SERIAL NOT NULL,
    "envelopeId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "detail" JSONB,
    "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signature_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "signature_envelopes_code_key" ON "signature_envelopes"("code");

-- CreateIndex
CREATE INDEX "signature_envelopes_contractId_idx" ON "signature_envelopes"("contractId");

-- CreateIndex
CREATE INDEX "signature_envelopes_status_idx" ON "signature_envelopes"("status");

-- CreateIndex
CREATE UNIQUE INDEX "signature_signers_tokenHash_key" ON "signature_signers"("tokenHash");

-- CreateIndex
CREATE UNIQUE INDEX "signature_signers_envelopeId_order_key" ON "signature_signers"("envelopeId", "order");

-- CreateIndex
CREATE INDEX "signature_events_envelopeId_seq_idx" ON "signature_events"("envelopeId", "seq");

-- AddForeignKey
ALTER TABLE "signature_envelopes" ADD CONSTRAINT "signature_envelopes_contractId_fkey" FOREIGN KEY ("contractId") REFERENCES "contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_envelopes" ADD CONSTRAINT "signature_envelopes_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "documents"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_envelopes" ADD CONSTRAINT "signature_envelopes_signedDocumentId_fkey" FOREIGN KEY ("signedDocumentId") REFERENCES "documents"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_envelopes" ADD CONSTRAINT "signature_envelopes_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_signers" ADD CONSTRAINT "signature_signers_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "signature_envelopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signature_events" ADD CONSTRAINT "signature_events_envelopeId_fkey" FOREIGN KEY ("envelopeId") REFERENCES "signature_envelopes"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Roadmap #36: the vocabulary of an envelope and its signers.
ALTER TABLE "signature_envelopes" ADD CONSTRAINT "signature_envelopes_status" CHECK ("status" IN ('SENT', 'COMPLETED', 'DECLINED', 'VOIDED', 'EXPIRED'));
ALTER TABLE "signature_envelopes" ADD CONSTRAINT "signature_envelopes_provider" CHECK ("provider" IN ('sandbox', 'http'));
ALTER TABLE "signature_signers" ADD CONSTRAINT "signature_signers_status" CHECK ("status" IN ('PENDING', 'SIGNED', 'DECLINED'));
ALTER TABLE "signature_signers" ADD CONSTRAINT "signature_signers_party" CHECK ("party" IN ('CLIENT', 'AGENCY'));

-- What the provider reported is appended, never rewritten.
CREATE FUNCTION signature_events_append_only() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'signature events are append-only' USING ERRCODE = 'check_violation';
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER "signature_events_append_only" BEFORE UPDATE ON "signature_events" FOR EACH ROW EXECUTE FUNCTION signature_events_append_only();
