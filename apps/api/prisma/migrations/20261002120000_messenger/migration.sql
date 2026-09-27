-- CreateTable
CREATE TABLE "messenger_links" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "username" TEXT,
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messenger_links_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messenger_actions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "state" TEXT NOT NULL DEFAULT 'OPEN',
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "result" JSONB,
    "chatId" TEXT,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "messenger_actions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "messenger_messages" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT,
    "provider" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "buttons" JSONB,
    "status" TEXT NOT NULL,
    "providerMessageId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "notificationKind" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sentAt" TIMESTAMP(3),

    CONSTRAINT "messenger_messages_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "messenger_links_userId_key" ON "messenger_links"("userId");

-- CreateIndex
CREATE UNIQUE INDEX "messenger_links_provider_chatId_key" ON "messenger_links"("provider", "chatId");

-- CreateIndex
CREATE UNIQUE INDEX "messenger_actions_token_key" ON "messenger_actions"("token");

-- CreateIndex
CREATE INDEX "messenger_actions_userId_state_idx" ON "messenger_actions"("userId", "state");

-- CreateIndex
CREATE INDEX "messenger_messages_status_createdAt_idx" ON "messenger_messages"("status", "createdAt");

-- CreateIndex
CREATE INDEX "messenger_messages_provider_chatId_createdAt_idx" ON "messenger_messages"("provider", "chatId", "createdAt");

-- AddForeignKey
ALTER TABLE "messenger_links" ADD CONSTRAINT "messenger_links_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messenger_actions" ADD CONSTRAINT "messenger_actions_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Roadmap #40: the vocabulary of links, actions and messages.
ALTER TABLE "messenger_links" ADD CONSTRAINT "messenger_links_provider" CHECK ("provider" IN ('sandbox', 'bale', 'telegram'));
ALTER TABLE "messenger_actions" ADD CONSTRAINT "messenger_actions_kind" CHECK ("kind" IN ('LINK', 'FORM_DECISION'));
ALTER TABLE "messenger_actions" ADD CONSTRAINT "messenger_actions_state" CHECK ("state" IN ('OPEN', 'AWAITING_REASON', 'DONE', 'EXPIRED'));
ALTER TABLE "messenger_messages" ADD CONSTRAINT "messenger_messages_direction" CHECK ("direction" IN ('OUT', 'IN'));
ALTER TABLE "messenger_messages" ADD CONSTRAINT "messenger_messages_status" CHECK ("status" IN ('QUEUED', 'SENT', 'FAILED', 'RECEIVED'));
