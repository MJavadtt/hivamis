-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "accountingExportId" TEXT,
ADD COLUMN     "accountingReversalExportId" TEXT;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "accountingExportId" TEXT;

-- CreateTable
CREATE TABLE "accounting_settings" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "accounts" JSONB NOT NULL,
    "clientCodes" JSONB NOT NULL DEFAULT '{}',
    "layout" JSONB NOT NULL,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "accounting_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_exports" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "periodTo" TIMESTAMP(3) NOT NULL,
    "vouchers" INTEGER NOT NULL,
    "lines" INTEGER NOT NULL,
    "debitTotal" DECIMAL(20,2) NOT NULL,
    "creditTotal" DECIMAL(20,2) NOT NULL,
    "fileName" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounting_exports_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "accounting_settings_organizationId_key" ON "accounting_settings"("organizationId");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_exports_organizationId_number_key" ON "accounting_exports"("organizationId", "number");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_accountingExportId_fkey" FOREIGN KEY ("accountingExportId") REFERENCES "accounting_exports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_accountingReversalExportId_fkey" FOREIGN KEY ("accountingReversalExportId") REFERENCES "accounting_exports"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_accountingExportId_fkey" FOREIGN KEY ("accountingExportId") REFERENCES "accounting_exports"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- A batch that does not balance is not a set of vouchers; the database refuses to hold one.
ALTER TABLE "accounting_exports" ADD CONSTRAINT "accounting_exports_balanced" CHECK ("debitTotal" = "creditTotal");
