-- The owner's report (2026-10-23): the system administrator controls each user's access, not only
-- each role's, and may work in anyone's account — openly, with every action recorded under their name.

-- A permission given to one person or withheld from them, on top of what their roles give.
CREATE TABLE "user_permission_overrides" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "permission" TEXT NOT NULL,
    "effect" TEXT NOT NULL,
    "grantedById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_permission_overrides_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "user_permission_overrides_values" CHECK ("effect" IN ('grant', 'deny'))
);

CREATE INDEX "user_permission_overrides_organizationId_idx" ON "user_permission_overrides"("organizationId");
CREATE UNIQUE INDEX "user_permission_overrides_userId_permission_key" ON "user_permission_overrides"("userId", "permission");

ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_userId_fkey" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_permission_overrides" ADD CONSTRAINT "user_permission_overrides_grantedById_fkey" FOREIGN KEY ("grantedById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A session the administrator opened in someone's account, and, on every audit row written under
-- it, who was really at the keyboard.
ALTER TABLE "sessions" ADD COLUMN "impersonatorId" TEXT;
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_impersonatorId_fkey" FOREIGN KEY ("impersonatorId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "audit_events" ADD COLUMN "impersonatorId" TEXT;
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_impersonatorId_fkey" FOREIGN KEY ("impersonatorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE INDEX "audit_events_impersonatorId_idx" ON "audit_events"("impersonatorId");

-- Why such a session, or a person's, ended: the administrator set the password, removed the person,
-- or left the account they were working in.
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_revoked_reason";
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_revoked_reason" CHECK ("revokedReason" IS NULL OR "revokedReason" IN
  ('ROTATED', 'REUSE', 'SIGNED_OUT', 'PASSWORD_CHANGED', 'DEACTIVATED', 'ROLES_CHANGED', 'DELEGATION_REVOKED', 'SUSPENDED',
   'PASSWORD_SET_BY_ADMIN', 'REMOVED', 'ACT_AS_ENDED'));
