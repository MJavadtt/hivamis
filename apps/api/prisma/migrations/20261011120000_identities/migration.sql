-- Hivamis task 4: signing in with a mobile number or a Google account, and asking to join.

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "phoneVerifiedAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "user_identities" (
    "id" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "subject" TEXT NOT NULL,
    "email" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "user_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "otp_codes" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "userId" TEXT,
    "codeHash" TEXT NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "otp_codes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sms_outbox" (
    "id" TEXT NOT NULL,
    "phone" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sms_outbox_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "oauth_states" (
    "id" TEXT NOT NULL,
    "stateHash" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "mode" TEXT NOT NULL,
    "codeVerifier" TEXT NOT NULL,
    "nonce" TEXT NOT NULL,
    "userId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "oauth_states_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_tickets" (
    "id" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_tickets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "signup_requests" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "method" TEXT NOT NULL,
    "fullName" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "phone" TEXT,
    "googleSubject" TEXT,
    "departmentCode" TEXT,
    "note" TEXT,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "decidedById" TEXT,
    "decidedAt" TIMESTAMP(3),
    "decisionNote" TEXT,
    "userId" TEXT,
    "ipAddress" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "signup_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_identities_userId_idx" ON "user_identities"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "user_identities_provider_subject_key" ON "user_identities"("provider", "subject");

-- CreateIndex
CREATE INDEX "otp_codes_phone_purpose_createdAt_idx" ON "otp_codes"("phone", "purpose", "createdAt");

-- CreateIndex
CREATE INDEX "sms_outbox_createdAt_idx" ON "sms_outbox"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "oauth_states_stateHash_key" ON "oauth_states"("stateHash");

-- CreateIndex
CREATE UNIQUE INDEX "login_tickets_tokenHash_key" ON "login_tickets"("tokenHash");

-- CreateIndex
CREATE INDEX "signup_requests_organizationId_status_createdAt_idx" ON "signup_requests"("organizationId", "status", "createdAt");

-- AddForeignKey
ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "otp_codes" ADD CONSTRAINT "otp_codes_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "login_tickets" ADD CONSTRAINT "login_tickets_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signup_requests" ADD CONSTRAINT "signup_requests_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signup_requests" ADD CONSTRAINT "signup_requests_decidedById_fkey" FOREIGN KEY ("decidedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "signup_requests" ADD CONSTRAINT "signup_requests_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A verified mobile signs a person in, so it belongs to one active person at a time.
CREATE UNIQUE INDEX "users_phone_verified_key" ON "users"("phone") WHERE "phoneVerifiedAt" IS NOT NULL AND "deletedAt" IS NULL;
-- coalesce: a comparison with a missing value is unknown, and a CHECK lets unknown through.
ALTER TABLE "users" ADD CONSTRAINT "users_verified_phone_shape" CHECK ("phoneVerifiedAt" IS NULL OR coalesce("phone" ~ '^09[0-9]{9}$', false));

ALTER TABLE "user_identities" ADD CONSTRAINT "user_identities_provider" CHECK ("provider" IN ('google'));

ALTER TABLE "otp_codes" ADD CONSTRAINT "otp_codes_purpose" CHECK ("purpose" IN ('LOGIN', 'SIGNUP', 'VERIFY_PHONE'));
ALTER TABLE "otp_codes" ADD CONSTRAINT "otp_codes_phone_shape" CHECK ("phone" ~ '^09[0-9]{9}$');
ALTER TABLE "otp_codes" ADD CONSTRAINT "otp_codes_attempts" CHECK ("attempts" >= 0);

ALTER TABLE "sms_outbox" ADD CONSTRAINT "sms_outbox_status" CHECK ("status" IN ('SENT', 'FAILED', 'SANDBOX'));

ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_mode" CHECK ("mode" IN ('LOGIN', 'SIGNUP', 'LINK'));
-- Linking an account is done by someone signed in; the other two never carry a person.
ALTER TABLE "oauth_states" ADD CONSTRAINT "oauth_states_link_user" CHECK (("mode" = 'LINK') = ("userId" IS NOT NULL));

ALTER TABLE "login_tickets" ADD CONSTRAINT "login_tickets_method" CHECK ("method" IN ('google'));

ALTER TABLE "signup_requests" ADD CONSTRAINT "signup_requests_method" CHECK ("method" IN ('PHONE', 'GOOGLE'));
ALTER TABLE "signup_requests" ADD CONSTRAINT "signup_requests_status" CHECK ("status" IN ('PENDING', 'APPROVED', 'REJECTED'));
-- Each request carries what it was proved with: a mobile, or a Google account.
ALTER TABLE "signup_requests" ADD CONSTRAINT "signup_requests_proof" CHECK (
  ("method" = 'PHONE' AND coalesce("phone" ~ '^09[0-9]{9}$', false)) OR ("method" = 'GOOGLE' AND "googleSubject" IS NOT NULL));
-- Decided means decided by someone, at a time; approved means an account came of it.
ALTER TABLE "signup_requests" ADD CONSTRAINT "signup_requests_decision" CHECK (
  ("status" = 'PENDING') = ("decidedAt" IS NULL) AND ("status" <> 'APPROVED' OR "userId" IS NOT NULL));
-- One open request per email in an organisation.
CREATE UNIQUE INDEX "signup_requests_pending_email_key" ON "signup_requests"("organizationId", lower("email")) WHERE "status" = 'PENDING';

-- Why a session ended. Only a token that was rotated away and then presented again is a sign of
-- theft; one ended by signing out, a password or role change, or a delegation's end is just over.
ALTER TABLE "sessions" ADD COLUMN "revokedReason" TEXT;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_revoked_reason" CHECK ("revokedReason" IS NULL OR "revokedReason" IN
  ('ROTATED', 'REUSE', 'SIGNED_OUT', 'PASSWORD_CHANGED', 'DEACTIVATED', 'ROLES_CHANGED', 'DELEGATION_REVOKED'));
