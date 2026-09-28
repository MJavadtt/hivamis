-- CreateTable
CREATE TABLE "custom_rules" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "entity" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "labelFa" TEXT NOT NULL,
    "messageFa" TEXT,
    "when" JSONB,
    "notifyRoles" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "retiredAt" TIMESTAMP(3),
    "retiredById" TEXT,
    "supersededById" TEXT,

    CONSTRAINT "custom_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "custom_rules_organizationId_entity_action_idx" ON "custom_rules"("organizationId", "entity", "action");

-- CreateIndex
CREATE UNIQUE INDEX "custom_rules_organizationId_code_version_key" ON "custom_rules"("organizationId", "code", "version");


-- Two kinds; a guard is a condition; one current version per rule; a rule is retired, never edited.
ALTER TABLE "custom_rules" ADD CONSTRAINT "custom_rules_kind" CHECK ("kind" IN ('GUARD', 'NOTIFY'));
ALTER TABLE "custom_rules" ADD CONSTRAINT "custom_rules_guard_has_condition" CHECK ("kind" <> 'GUARD' OR "when" IS NOT NULL);
CREATE UNIQUE INDEX "custom_rules_one_current" ON "custom_rules"("organizationId", "code") WHERE "retiredAt" IS NULL;

CREATE FUNCTION custom_rules_immutable() RETURNS trigger AS $$
BEGIN
  IF NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."entity" IS DISTINCT FROM OLD."entity" OR NEW."action" IS DISTINCT FROM OLD."action"
    OR NEW."labelFa" IS DISTINCT FROM OLD."labelFa" OR NEW."messageFa" IS DISTINCT FROM OLD."messageFa" OR NEW."when"::text IS DISTINCT FROM OLD."when"::text
    OR NEW."notifyRoles" IS DISTINCT FROM OLD."notifyRoles" OR NEW."code" IS DISTINCT FROM OLD."code" OR NEW."version" IS DISTINCT FROM OLD."version" THEN
    RAISE EXCEPTION 'custom_rules: a rule version is never edited — publish a new version';
  END IF;
  RETURN NEW;
END $$ LANGUAGE plpgsql;
CREATE TRIGGER custom_rules_immutable BEFORE UPDATE ON "custom_rules" FOR EACH ROW EXECUTE FUNCTION custom_rules_immutable();
