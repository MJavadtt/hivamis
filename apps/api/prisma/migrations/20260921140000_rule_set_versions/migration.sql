-- Effective-dated rule sets (roadmap #4): each version of the workflows, permissions and SLA
-- catalogue is a row, and every transition records the versions in force when it happened.

-- AlterTable
ALTER TABLE "state_transitions" ADD COLUMN     "permissionsVersionId" TEXT,
ADD COLUMN     "rulesVersionId" TEXT;

-- CreateTable
CREATE TABLE "rule_set_versions" (
    "id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "hash" TEXT NOT NULL,
    "snapshot" JSONB NOT NULL,
    "effectiveFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "rule_set_versions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "rule_set_versions_kind_version_key" ON "rule_set_versions"("kind", "version");

-- CreateIndex
CREATE UNIQUE INDEX "rule_set_versions_kind_hash_key" ON "rule_set_versions"("kind", "hash");


