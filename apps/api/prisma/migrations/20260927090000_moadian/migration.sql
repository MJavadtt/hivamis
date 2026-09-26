-- AlterTable
ALTER TABLE "companies" ADD COLUMN     "postalCode" TEXT;

-- CreateTable
CREATE TABLE "tax_profiles" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "memoryId" TEXT NOT NULL,
    "sellerTaxId" TEXT NOT NULL,
    "economicCode" TEXT,
    "postalCode" TEXT,
    "branchCode" TEXT,
    "defaultServiceCode" TEXT NOT NULL,
    "defaultUnitCode" TEXT NOT NULL,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "tax_profiles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tax_submissions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "invoiceId" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "serial" INTEGER NOT NULL,
    "taxId" TEXT NOT NULL,
    "referenceTaxId" TEXT,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "referenceNumber" TEXT,
    "errors" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "channel" TEXT,
    "submittedAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "tax_submissions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "tax_profiles_organizationId_key" ON "tax_profiles"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "tax_submissions_taxId_key" ON "tax_submissions"("taxId");

-- CreateIndex
CREATE INDEX "tax_submissions_organizationId_status_idx" ON "tax_submissions"("organizationId", "status");

-- CreateIndex
CREATE INDEX "tax_submissions_invoiceId_idx" ON "tax_submissions"("invoiceId");

-- AddForeignKey
ALTER TABLE "tax_submissions" ADD CONSTRAINT "tax_submissions_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- The subjects and states a submission can have; a tax number is 22 characters of 0-9A-F bar the memory id.
ALTER TABLE "tax_submissions" ADD CONSTRAINT "tax_submissions_subject_check" CHECK ("subject" IN ('ORIGINAL', 'CORRECTION', 'CANCELLATION'));
ALTER TABLE "tax_submissions" ADD CONSTRAINT "tax_submissions_status_check" CHECK ("status" IN ('QUEUED', 'SENT', 'ACCEPTED', 'REJECTED', 'FAILED'));
ALTER TABLE "tax_submissions" ADD CONSTRAINT "tax_submissions_taxid_shape" CHECK (char_length("taxId") = 22);
