-- Roadmap #49: Web Push for the three short-deadline loops, and photos kept as a QC review's evidence.
-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "qcReviewId" TEXT;

-- CreateTable
CREATE TABLE "push_subscriptions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "p256dh" TEXT NOT NULL,
    "auth" TEXT NOT NULL,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSuccessAt" TIMESTAMP(3),
    "failures" INTEGER NOT NULL DEFAULT 0,
    "disabledAt" TIMESTAMP(3),
    "disabledReason" TEXT,

    CONSTRAINT "push_subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "push_messages" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "subscriptionId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "url" TEXT NOT NULL,
    "tag" TEXT,
    "status" TEXT NOT NULL DEFAULT 'QUEUED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "statusCode" INTEGER,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "push_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "server_keys" (
    "name" TEXT NOT NULL,
    "publicKey" TEXT NOT NULL,
    "privateKey" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "server_keys_pkey" PRIMARY KEY ("name")
);

-- CreateIndex
CREATE UNIQUE INDEX "push_subscriptions_endpoint_key" ON "push_subscriptions"("endpoint");

-- CreateIndex
CREATE INDEX "push_subscriptions_userId_idx" ON "push_subscriptions"("userId");

-- CreateIndex
CREATE INDEX "push_messages_status_createdAt_idx" ON "push_messages"("status", "createdAt");

-- CreateIndex
CREATE INDEX "push_messages_userId_createdAt_idx" ON "push_messages"("userId", "createdAt");

-- CreateIndex
CREATE INDEX "documents_qcReviewId_idx" ON "documents"("qcReviewId");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_qcReviewId_fkey" FOREIGN KEY ("qcReviewId") REFERENCES "qc_reviews"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "push_messages" ADD CONSTRAINT "push_messages_subscriptionId_fkey" FOREIGN KEY ("subscriptionId") REFERENCES "push_subscriptions"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A message is in exactly one of four states; a subscription is switched off with its reason, or not at all.
ALTER TABLE "push_messages" ADD CONSTRAINT "push_messages_status_check" CHECK ("status" IN ('QUEUED', 'SENT', 'FAILED', 'GONE'));
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_disabled_with_reason" CHECK (("disabledAt" IS NULL) = ("disabledReason" IS NULL));
