-- QC stage zero (roadmap #22): the mechanical checks run at the unit's handover, stored so the
-- Account reviewer sees them before opening a file.
ALTER TABLE "deliverables" ADD COLUMN "stageZeroVerdict" TEXT,
ADD COLUMN "stageZeroAt" TIMESTAMP(3),
ADD COLUMN "stageZeroFindings" JSONB;
