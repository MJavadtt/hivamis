-- Approval chains and quorum (roadmap #18). Stages live on the definition and are versioned
-- with it; a submission carries the stages it must pass and how far it has got, and each
-- approval records which stage it satisfied.
ALTER TABLE "form_approvals" ADD COLUMN     "stage" TEXT;
ALTER TABLE "form_definition_versions" ADD COLUMN     "approvalChain" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "form_definitions" ADD COLUMN     "approvalChain" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "form_submissions" ADD COLUMN     "currentStage" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stages" JSONB;
