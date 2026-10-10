-- Audit SEC-1 (ADR-067): a contact carries its company's organisation, so every query on contacts
-- scopes on it directly, and the database refuses a contact whose organisation is not its company's.

-- The composite key a contact points at.
CREATE UNIQUE INDEX "companies_id_organizationId_key" ON "companies"("id", "organizationId");

-- Filled from the company before it may be required.
ALTER TABLE "contacts" ADD COLUMN "organizationId" TEXT;
UPDATE "contacts" c SET "organizationId" = co."organizationId" FROM "companies" co WHERE co."id" = c."companyId";
ALTER TABLE "contacts" ALTER COLUMN "organizationId" SET NOT NULL;

-- The company and the organisation together: a contact cannot name another organisation's company.
ALTER TABLE "contacts" DROP CONSTRAINT "contacts_companyId_fkey";
ALTER TABLE "contacts" ADD CONSTRAINT "contacts_companyId_organizationId_fkey" FOREIGN KEY ("companyId", "organizationId") REFERENCES "companies"("id", "organizationId") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE INDEX "contacts_organizationId_companyId_idx" ON "contacts"("organizationId", "companyId");
