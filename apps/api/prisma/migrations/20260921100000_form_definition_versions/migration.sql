-- Form definition versioning (roadmap #16). A submission now pins the definition version it
-- was filled in under, so a schema change stops re-rendering every past submission — and every
-- archived PDF's source data — under the new fields.

-- AlterTable
ALTER TABLE "form_submissions" ADD COLUMN     "definitionVersion" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "form_definition_versions" (
    "id" TEXT NOT NULL,
    "definitionId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "schema" JSONB NOT NULL,
    "nameFa" TEXT NOT NULL,
    "note" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "form_definition_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "form_definition_versions_definitionId_version_key" ON "form_definition_versions"("definitionId", "version");

-- AddForeignKey
ALTER TABLE "form_definition_versions" ADD CONSTRAINT "form_definition_versions_definitionId_fkey" FOREIGN KEY ("definitionId") REFERENCES "form_definitions"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: every existing definition becomes its own version 1..n row as it stands today, and
-- every existing submission is pinned to that. The schema those submissions were actually
-- filled under is not recoverable; today's is the best available picture, and from here on it
-- cannot drift.
INSERT INTO "form_definition_versions" ("id", "definitionId", "version", "schema", "nameFa", "note", "createdAt")
SELECT gen_random_uuid(), "id", "version", "schema", "nameFa",
       'backfilled from the definition as it stood when versioning was introduced', CURRENT_TIMESTAMP
FROM "form_definitions";

UPDATE "form_submissions" s
   SET "definitionVersion" = d."version"
  FROM "form_definitions" d
 WHERE d."id" = s."definitionId";
