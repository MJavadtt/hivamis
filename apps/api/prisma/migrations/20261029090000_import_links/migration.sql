-- Moving in from another system (the owner's Mizito and client sheet, 2026-10-28).

-- The client's code in the organisation's own books, its email and notes.
ALTER TABLE "companies" ADD COLUMN "clientCode" TEXT;
ALTER TABLE "companies" ADD COLUMN "email" TEXT;
ALTER TABLE "companies" ADD COLUMN "notes" TEXT;
CREATE UNIQUE INDEX "companies_organizationId_clientCode_key" ON "companies"("organizationId", "clientCode");

-- What the move made of each source record: run twice, it makes nothing twice.
CREATE TABLE "import_links" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "source" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "entityType" TEXT NOT NULL,
    "entityId" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "import_links_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "import_links_organizationId_source_externalId_key" ON "import_links"("organizationId", "source", "externalId");
CREATE INDEX "import_links_entityType_entityId_idx" ON "import_links"("entityType", "entityId");
ALTER TABLE "import_links" ADD CONSTRAINT "import_links_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "import_links" ADD CONSTRAINT "import_links_source_check" CHECK ("source" IN ('mizito', 'sheet'));
