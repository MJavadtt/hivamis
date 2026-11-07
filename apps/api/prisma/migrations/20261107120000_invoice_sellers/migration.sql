-- ADR-125: invoices are issued in «هیوا» or «خط تیره», each printed on its own form.
CREATE TABLE "invoice_sellers" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "form" TEXT NOT NULL,
    "shortName" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "economicCode" TEXT,
    "nationalId" TEXT,
    "province" TEXT,
    "county" TEXT,
    "city" TEXT,
    "address" TEXT,
    "postalCode" TEXT,
    "phone" TEXT,
    "bankName" TEXT,
    "accountNumber" TEXT,
    "iban" TEXT,
    "updatedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "invoice_sellers_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "invoice_sellers_organizationId_form_key" ON "invoice_sellers"("organizationId", "form");

ALTER TABLE "invoices" ADD COLUMN "sellerId" TEXT,
    ADD COLUMN "sellerDetails" JSONB,
    ADD COLUMN "buyer" JSONB,
    ADD COLUMN "saleTerms" TEXT;
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_sellerId_fkey" FOREIGN KEY ("sellerId") REFERENCES "invoice_sellers"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "companies" ADD COLUMN "province" TEXT,
    ADD COLUMN "county" TEXT,
    ADD COLUMN "city" TEXT;
