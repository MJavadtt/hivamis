-- Asking to join with an email and a password of one's own, for an installation without SMS or Google
-- (owner's server report, 2026-10-28). Nothing is proved by it: the administrator's approval is the check.
ALTER TABLE "signup_requests" ADD COLUMN "passwordHash" TEXT;

ALTER TABLE "signup_requests" DROP CONSTRAINT "signup_requests_method";
ALTER TABLE "signup_requests" ADD CONSTRAINT "signup_requests_method" CHECK ("method" IN ('PHONE', 'GOOGLE', 'PASSWORD'));
-- A mobile proved, a Google account, or — waiting for its decision — the chosen password; a number
-- typed into a password request is still a mobile number.
ALTER TABLE "signup_requests" DROP CONSTRAINT "signup_requests_proof";
ALTER TABLE "signup_requests" ADD CONSTRAINT "signup_requests_proof" CHECK (
  ("method" = 'PHONE' AND coalesce("phone" ~ '^09[0-9]{9}$', false))
  OR ("method" = 'GOOGLE' AND "googleSubject" IS NOT NULL)
  OR ("method" = 'PASSWORD' AND ("phone" IS NULL OR "phone" ~ '^09[0-9]{9}$') AND ("status" <> 'PENDING' OR "passwordHash" IS NOT NULL)));
-- The chosen password is a password request's, and only until it is decided: then it is the account's, or nobody's.
ALTER TABLE "signup_requests" ADD CONSTRAINT "signup_requests_password" CHECK (
  "passwordHash" IS NULL OR ("method" = 'PASSWORD' AND "status" = 'PENDING'));
