-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "brandRole" TEXT,
ADD COLUMN     "lineageId" TEXT,
ADD COLUMN     "metadata" JSONB,
ADD COLUMN     "supersededAt" TIMESTAMP(3),
ADD COLUMN     "supersededById" TEXT;

-- CreateTable
CREATE TABLE "brand_kits" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "colors" JSONB NOT NULL DEFAULT '[]',
    "fonts" JSONB NOT NULL DEFAULT '[]',
    "notes" TEXT,
    "updatedById" TEXT NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "brand_kits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "brand_kits_companyId_key" ON "brand_kits"("companyId");

-- CreateIndex
CREATE INDEX "documents_lineageId_idx" ON "documents"("lineageId");

-- AddForeignKey
ALTER TABLE "brand_kits" ADD CONSTRAINT "brand_kits_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "companies"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Roadmap #42: a brand file says what it is, and a superseded version names what replaced it.
ALTER TABLE "documents" ADD CONSTRAINT "documents_brand_role" CHECK ("brandRole" IS NULL OR "brandRole" IN ('LOGO', 'FONT', 'GUIDELINE', 'IMAGE', 'OTHER'));
ALTER TABLE "documents" ADD CONSTRAINT "documents_superseded" CHECK (("supersededAt" IS NULL) = ("supersededById" IS NULL));
-- Each file is the first of its own line until a version is added.
UPDATE "documents" SET "lineageId" = "id" WHERE "lineageId" IS NULL;
