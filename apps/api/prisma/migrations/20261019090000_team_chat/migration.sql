-- Audit F-5: team chat — direct conversations, private groups and channels, with messages that keep
-- their edits, files shared as documents, and disclosed oversight under audit.

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "chatConversationId" TEXT,
ADD COLUMN     "chatMessageId" TEXT;

-- CreateTable
CREATE TABLE "chat_conversations" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT,
    "topic" TEXT,
    "directKey" TEXT,
    "createdById" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3),
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "chat_conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_members" (
    "conversationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'MEMBER',
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "notify" TEXT NOT NULL DEFAULT 'ALL',
    "lastReadAt" TIMESTAMP(3),
    "joinedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "leftAt" TIMESTAMP(3),

    CONSTRAINT "chat_members_pkey" PRIMARY KEY ("conversationId","userId")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "replyToId" TEXT,
    "mentionIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "deletedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_message_edits" (
    "id" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "editedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_message_edits_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "chat_conversations_organizationId_kind_idx" ON "chat_conversations"("organizationId", "kind");

-- CreateIndex
CREATE UNIQUE INDEX "chat_conversations_organizationId_directKey_key" ON "chat_conversations"("organizationId", "directKey");

-- CreateIndex
CREATE INDEX "chat_members_userId_idx" ON "chat_members"("userId");

-- CreateIndex
CREATE INDEX "chat_messages_conversationId_createdAt_idx" ON "chat_messages"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "chat_message_edits_messageId_idx" ON "chat_message_edits"("messageId");

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_chatConversationId_fkey" FOREIGN KEY ("chatConversationId") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documents" ADD CONSTRAINT "documents_chatMessageId_fkey" FOREIGN KEY ("chatMessageId") REFERENCES "chat_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "chat_conversations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_replyToId_fkey" FOREIGN KEY ("replyToId") REFERENCES "chat_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_message_edits" ADD CONSTRAINT "chat_message_edits_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "chat_messages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- What the columns may hold.
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_kind_check" CHECK ("kind" IN ('DIRECT', 'GROUP', 'CHANNEL'));
-- A direct conversation is one pair's, named by it; nothing else has a pair key.
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_direct_check" CHECK (("kind" = 'DIRECT') = ("directKey" IS NOT NULL));
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_role_check" CHECK ("role" IN ('OWNER', 'ADMIN', 'MEMBER'));
ALTER TABLE "chat_members" ADD CONSTRAINT "chat_members_notify_check" CHECK ("notify" IN ('ALL', 'MENTIONS', 'NONE'));
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_body_check" CHECK (char_length("body") <= 4000);

CREATE INDEX "documents_chatConversationId_idx" ON "documents"("chatConversationId");

-- Live (roadmap #39): a message announces itself when its transaction commits — that it exists,
-- not what it says; each stream passes it only to the conversation's members.
CREATE FUNCTION hiva_notify_chat_message() RETURNS trigger AS $$
BEGIN
  PERFORM pg_notify('hiva_events', json_build_object(
    't', 'chat', 'schema', current_schema(), 'org', NEW."organizationId", 'conversation', NEW."conversationId",
    'message', NEW."id", 'author', NEW."authorId", 'op', lower(TG_OP)
  )::text);
  RETURN NEW;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER "chat_messages_announce" AFTER INSERT OR UPDATE ON "chat_messages" FOR EACH ROW EXECUTE FUNCTION hiva_notify_chat_message();

-- Who is in a conversation changed: the streams forget what they knew of it.
CREATE FUNCTION hiva_notify_chat_member() RETURNS trigger AS $$
DECLARE r record;
BEGIN
  r := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
  PERFORM pg_notify('hiva_events', json_build_object(
    't', 'chat_members', 'schema', current_schema(), 'conversation', r."conversationId", 'user', r."userId"
  )::text);
  RETURN r;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER "chat_members_announce" AFTER INSERT OR UPDATE OR DELETE ON "chat_members" FOR EACH ROW EXECUTE FUNCTION hiva_notify_chat_member();

-- A look at someone else's conversation — or at who talks with whom — is written down for good
-- (CHAT_OVERSIGHT_VIEW, CHAT_OVERSIGHT_LIST): the record of a review cannot
-- be changed, deleted, or emptied with the table — whatever the application does. (Removing a
-- reviewer's account is refused while it would blank their name on one.)
CREATE FUNCTION hiva_keep_oversight_rows() RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'TRUNCATE' THEN
    IF EXISTS (SELECT 1 FROM "audit_events" WHERE "action" LIKE 'CHAT\_OVERSIGHT\_%') THEN
      RAISE EXCEPTION 'the record of conversation reviews cannot be removed';
    END IF;
    RETURN NULL;
  END IF;
  IF OLD."action" LIKE 'CHAT\_OVERSIGHT\_%' THEN
    RAISE EXCEPTION 'the record of a conversation review cannot be changed or deleted';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$ LANGUAGE plpgsql;
CREATE TRIGGER "audit_events_keep_oversight" BEFORE UPDATE OR DELETE ON "audit_events" FOR EACH ROW EXECUTE FUNCTION hiva_keep_oversight_rows();
CREATE TRIGGER "audit_events_keep_oversight_truncate" BEFORE TRUNCATE ON "audit_events" FOR EACH STATEMENT EXECUTE FUNCTION hiva_keep_oversight_rows();
