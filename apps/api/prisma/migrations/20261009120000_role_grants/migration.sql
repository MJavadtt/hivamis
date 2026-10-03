-- Hivamis task 6: each role's permissions as the organisation's system administrator granted them.


-- CreateTable
CREATE TABLE "role_grants" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "roleCode" TEXT NOT NULL,
    "permissions" TEXT[],
    "note" TEXT,
    "grantedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "supersededAt" TIMESTAMP(3),

    CONSTRAINT "role_grants_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "role_grants_organizationId_roleCode_idx" ON "role_grants"("organizationId", "roleCode");


-- One grant in force per role; the rest are its history.
CREATE UNIQUE INDEX "role_grants_one_current" ON "role_grants"("organizationId", "roleCode") WHERE "supersededAt" IS NULL;
-- The managing director, deputy, system administrator and account manager hold everything — nothing to grant.
ALTER TABLE "role_grants" ADD CONSTRAINT "role_grants_not_full_access" CHECK ("roleCode" NOT IN ('SUPER_ADMIN', 'CEO', 'DEPUTY', 'ACCOUNT_MANAGER'));
