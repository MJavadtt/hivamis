-- Audit F-9, step 1: the bot can read its updates by long polling, where no public webhook can
-- reach the server. Telegram gives a bot's updates to one reader, so a lease names the process
-- reading them; the row also keeps the next offset and when a poll last completed.
CREATE TABLE "messenger_poll_state" (
    "provider" TEXT NOT NULL,
    "holder" TEXT,
    "leaseUntil" TIMESTAMP(3),
    "nextOffset" BIGINT NOT NULL DEFAULT 0,
    "lastPollAt" TIMESTAMP(3),
    "lastError" TEXT,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messenger_poll_state_pkey" PRIMARY KEY ("provider"),
    CONSTRAINT "messenger_poll_state_values" CHECK (
      "provider" IN ('bale', 'telegram') AND "nextOffset" >= 0 AND char_length(coalesce("lastError", '')) <= 500
    )
);

-- A Telegram account is a way into the Mini App, linked with the messenger chat by the code its
-- owner sent the bot from a signed-in session; never matched by email (finding 2).
ALTER TABLE "user_identities" DROP CONSTRAINT "user_identities_provider";
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_provider" CHECK ("provider" IN ('google', 'telegram'));

-- A Mini App launch, once used, is kept as a spent ticket so that a copy of it is refused.
ALTER TABLE "login_tickets" DROP CONSTRAINT "login_tickets_method";
ALTER TABLE "login_tickets" ADD CONSTRAINT "login_tickets_method" CHECK ("method" IN ('google', 'telegram'));
