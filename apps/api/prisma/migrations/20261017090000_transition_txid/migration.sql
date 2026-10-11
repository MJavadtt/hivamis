-- Audit LOG-1: webhooks read the transition log by transaction id, below the oldest transaction still
-- running, so a row that commits late is never behind the cursor. See ADR-075.

-- Rows already written are all committed: 0 puts them before everything to come. The constant default
-- fills them without rewriting the table; the database stamps every new row with its own transaction.
ALTER TABLE "state_transitions" ADD COLUMN "txid" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "state_transitions" ALTER COLUMN "txid" SET DEFAULT ((pg_current_xact_id())::text)::bigint;
CREATE INDEX "state_transitions_organizationId_txid_id_idx" ON "state_transitions"("organizationId", "txid", "id");

-- Existing subscriptions read the old rows once more, from the start: what they were already sent is
-- not sent again (webhook_deliveries is unique per subscription and transition), and cursorAt still
-- keeps out what came before it. A new subscription starts at the oldest transaction then running.
ALTER TABLE "webhook_subscriptions" ADD COLUMN "cursorTxid" BIGINT NOT NULL DEFAULT 0;
ALTER TABLE "webhook_subscriptions" ALTER COLUMN "cursorTxid" SET DEFAULT ((pg_snapshot_xmin(pg_current_snapshot()))::text)::bigint;
UPDATE "webhook_subscriptions" SET "cursorId" = NULL;
