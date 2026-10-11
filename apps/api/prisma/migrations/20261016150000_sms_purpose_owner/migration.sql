-- Audit SEC-6: an outbox message says what its code was for and whose account it opens, so the sandbox
-- outbox can show a code only when it opens no account, or to its own owner. Older rows have neither,
-- and are shown masked.
ALTER TABLE "sms_outbox" ADD COLUMN "purpose" TEXT,
ADD COLUMN "userId" TEXT;
ALTER TABLE "sms_outbox" ADD CONSTRAINT "sms_outbox_purpose" CHECK ("purpose" IS NULL OR "purpose" IN ('LOGIN', 'SIGNUP', 'VERIFY_PHONE'));
ALTER TABLE "sms_outbox" ADD CONSTRAINT "sms_outbox_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
