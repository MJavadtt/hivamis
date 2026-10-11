-- Audit LOG-4: a person's email is unique within their organisation, not across the installation —
-- the same person may work for two organisations on one installation, under one address.
DROP INDEX "users_email_key";
CREATE UNIQUE INDEX "users_organizationId_email_key" ON "users"("organizationId", "email");
