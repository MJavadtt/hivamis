-- A key the client generates before the form leaves the device (roadmap #19). A submission
-- queued on a phone with no signal and retried over a flaky link must file once, not once per
-- attempt; the unique index is what makes the retry safe.
ALTER TABLE "form_submissions" ADD COLUMN     "clientKey" TEXT;
CREATE UNIQUE INDEX "form_submissions_organizationId_clientKey_key" ON "form_submissions"("organizationId", "clientKey");
