-- Audit SEC-3: access tokens end with what they were issued on.

-- Raised on a role change, deactivation or password change; every access token carries its value.
ALTER TABLE "users" ADD COLUMN "authVersion" INTEGER NOT NULL DEFAULT 0;

-- The sign-in a session row continues. Rows from before have no recorded chain: each is its own family,
-- so a token issued for a row rotated before this migration is refused once and its holder refreshes.
ALTER TABLE "sessions" ADD COLUMN "familyId" TEXT;
UPDATE "sessions" SET "familyId" = "id";
ALTER TABLE "sessions" ALTER COLUMN "familyId" SET NOT NULL;
CREATE INDEX "sessions_familyId_idx" ON "sessions"("familyId");
