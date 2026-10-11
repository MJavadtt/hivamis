-- Audit SEC-5: Google sign-in is honoured only in the browser that began it, and a Google account is
-- linked to a work address only after the person proves the account is theirs.

-- The hash of the nonce in the starting browser's cookie. Rows from before have none, and are refused:
-- they expire within ten minutes of being made.
ALTER TABLE "oauth_states" ADD COLUMN "bindingHash" TEXT;

CREATE TABLE "identity_link_offers" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "identity_link_offers_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "identity_link_offers_provider" CHECK ("provider" IN ('google')),
    CONSTRAINT "identity_link_offers_attempts" CHECK ("attempts" BETWEEN 0 AND 5)
);
CREATE UNIQUE INDEX "identity_link_offers_tokenHash_key" ON "identity_link_offers"("tokenHash");
CREATE INDEX "identity_link_offers_userId_idx" ON "identity_link_offers"("userId");
ALTER TABLE "identity_link_offers" ADD CONSTRAINT "identity_link_offers_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
