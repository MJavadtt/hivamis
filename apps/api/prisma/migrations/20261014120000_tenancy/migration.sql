-- Roadmap #50: more than one organisation on one installation, and an upgrade that brings each
-- organisation's reference data — roles, units, SLA policies, the form catalogue — up to the code.

-- A form or an SLA policy is named within its organisation; another organisation has its own.
DROP INDEX "form_definitions_code_key";
DROP INDEX "sla_policies_code_key";
CREATE UNIQUE INDEX "form_definitions_organizationId_code_key" ON "form_definitions"("organizationId", "code");
CREATE UNIQUE INDEX "sla_policies_organizationId_code_key" ON "sla_policies"("organizationId", "code");

-- Hours the organisation set itself are not moved by an upgrade.
ALTER TABLE "sla_policies" ADD COLUMN "customizedAt" TIMESTAMP(3);

-- The organisation's short name, the host names that open it, and whether it is in service.
ALTER TABLE "organizations" ADD COLUMN "hosts" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "isActive" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN "slug" TEXT;
CREATE UNIQUE INDEX "organizations_slug_key" ON "organizations"("slug");
ALTER TABLE "organizations" ADD CONSTRAINT "organizations_slug_check" CHECK ("slug" IS NULL OR "slug" ~ '^[a-z0-9][a-z0-9-]{1,39}$');

-- Each run of the reference sync, and what it changed.
CREATE TABLE "system_upgrades" (
    "id" TEXT NOT NULL,
    "appVersion" TEXT NOT NULL,
    "trigger" TEXT NOT NULL,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "summary" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "system_upgrades_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "system_upgrades_trigger_check" CHECK ("trigger" IN ('startup', 'manual', 'provision', 'seed'))
);
CREATE INDEX "system_upgrades_startedAt_idx" ON "system_upgrades"("startedAt");

-- Asking to join with Google comes back to the installation's one address: the organisation it
-- began in travels with the sign-in state.
ALTER TABLE "oauth_states" ADD COLUMN "organizationId" TEXT;

-- A suspended organisation's sessions end with their own reason, read as neither theft nor sign-out.
ALTER TABLE "sessions" DROP CONSTRAINT "sessions_revoked_reason";
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_revoked_reason" CHECK ("revokedReason" IS NULL OR "revokedReason" IN
  ('ROTATED', 'REUSE', 'SIGNED_OUT', 'PASSWORD_CHANGED', 'DEACTIVATED', 'ROLES_CHANGED', 'DELEGATION_REVOKED', 'SUSPENDED'));

