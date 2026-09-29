-- AlterTable
ALTER TABLE "projects" ADD COLUMN     "legacyRef" TEXT;

-- AlterTable
ALTER TABLE "state_transitions" ADD COLUMN     "opening" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "account_activations" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "account_activations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "account_activations_tokenHash_key" ON "account_activations"("tokenHash");

-- CreateIndex
CREATE INDEX "account_activations_userId_idx" ON "account_activations"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "projects_organizationId_legacyRef_key" ON "projects"("organizationId", "legacyRef");


-- An activation is spent once; a used or revoked one never comes back.
ALTER TABLE "account_activations" ADD CONSTRAINT "account_activations_one_end" CHECK ("usedAt" IS NULL OR "revokedAt" IS NULL);
