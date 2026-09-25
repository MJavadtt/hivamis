-- AlterTable
ALTER TABLE "amendments" ADD COLUMN     "fxRate" DECIMAL(24,6) NOT NULL DEFAULT 1,
ADD COLUMN     "fxRateDate" TIMESTAMP(3),
ADD COLUMN     "originalValueDelta" DECIMAL(20,2);

-- AlterTable
ALTER TABLE "contracts" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'IRR',
ADD COLUMN     "fxRate" DECIMAL(24,6) NOT NULL DEFAULT 1,
ADD COLUMN     "fxRateDate" TIMESTAMP(3),
ADD COLUMN     "originalValue" DECIMAL(20,2);

-- AlterTable
ALTER TABLE "cost_declarations" ADD COLUMN     "externalCurrency" TEXT NOT NULL DEFAULT 'IRR',
ADD COLUMN     "fxRate" DECIMAL(24,6) NOT NULL DEFAULT 1,
ADD COLUMN     "fxRateDate" TIMESTAMP(3),
ADD COLUMN     "originalExternalCost" DECIMAL(20,2);

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'IRR',
ADD COLUMN     "fxRate" DECIMAL(24,6) NOT NULL DEFAULT 1,
ADD COLUMN     "fxRateDate" TIMESTAMP(3),
ADD COLUMN     "originalPaidAmount" DECIMAL(20,2),
ADD COLUMN     "originalSubtotal" DECIMAL(20,2),
ADD COLUMN     "originalTaxAmount" DECIMAL(20,2),
ADD COLUMN     "originalTotal" DECIMAL(20,2);

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "currency" TEXT NOT NULL DEFAULT 'IRR',
ADD COLUMN     "fxRate" DECIMAL(24,6) NOT NULL DEFAULT 1,
ADD COLUMN     "fxRateDate" TIMESTAMP(3),
ADD COLUMN     "originalAmount" DECIMAL(20,2),
ADD COLUMN     "settledOriginal" DECIMAL(20,2);

-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "contractCurrency" TEXT NOT NULL DEFAULT 'IRR',
ADD COLUMN     "originalContractValue" DECIMAL(20,2);

-- CreateTable
CREATE TABLE "exchange_rates" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "currency" TEXT NOT NULL,
    "rate" DECIMAL(24,6) NOT NULL,
    "effectiveDate" DATE NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'MANUAL',
    "note" TEXT,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "exchange_rates_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "exchange_rates_organizationId_currency_effectiveDate_key" ON "exchange_rates"("organizationId", "currency", "effectiveDate");


-- A rate is base units for one unit of the currency: never zero, never negative.
ALTER TABLE "exchange_rates" ADD CONSTRAINT "exchange_rates_rate_positive" CHECK ("rate" > 0);

-- Every existing figure was written in its organisation's own currency.
UPDATE "invoices" i SET "currency" = o."currency" FROM "organizations" o WHERE o."id" = i."organizationId";
UPDATE "payments" p SET "currency" = o."currency" FROM "organizations" o WHERE o."id" = p."organizationId";
UPDATE "cost_declarations" c SET "externalCurrency" = o."currency" FROM "organizations" o WHERE o."id" = c."organizationId";
UPDATE "contracts" c SET "currency" = o."currency" FROM "organizations" o WHERE o."id" = c."organizationId";
UPDATE "projects" p SET "contractCurrency" = o."currency" FROM "organizations" o WHERE o."id" = p."organizationId";
