-- Audit CALC-1: work in progress compared invoices with VAT against revenue earned without it. Whether
-- contract values include VAT is now the organisation's to say; off, the usual practice.
ALTER TABLE "organizations" ADD COLUMN "contractValueIncludesTax" BOOLEAN NOT NULL DEFAULT false;
