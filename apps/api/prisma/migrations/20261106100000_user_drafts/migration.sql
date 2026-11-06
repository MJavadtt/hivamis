-- What a person typed and has not saved (ADR-122).
CREATE TABLE "user_drafts" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "fields" JSONB NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "user_drafts_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "user_drafts_userId_key_key" ON "user_drafts"("userId", "key");
CREATE INDEX "user_drafts_organizationId_idx" ON "user_drafts"("organizationId");
ALTER TABLE "user_drafts" ADD CONSTRAINT "user_drafts_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_drafts" ADD CONSTRAINT "user_drafts_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
