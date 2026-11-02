-- The owner's «فرآیند محیطی» (2026-11-02), ADR-120.

-- WORKFLOWS.proposal: the media unit's manager approves a proposal the unit worked on, after pricing.
ALTER TABLE "proposals" DROP CONSTRAINT IF EXISTS "proposals_state_check";
ALTER TABLE "proposals" ADD CONSTRAINT "proposals_state_check" CHECK ("state" IN ('DRAFT', 'AWAITING_UNIT_OUTPUTS', 'INTEGRATION', 'PRICING', 'UNIT_APPROVAL', 'FINAL_QC', 'APPROVED', 'DELIVERED_TO_SALES', 'PRESENTED_TO_CLIENT', 'CLIENT_REVISION_REQUESTED', 'CLIENT_APPROVED', 'CLIENT_REJECTED'));

-- What a deliverable is, where the process needs to tell: an out-of-home display's artwork and its reports.
ALTER TABLE "deliverables" ADD COLUMN "kind" TEXT;
ALTER TABLE "deliverables" ADD CONSTRAINT "deliverables_kind_check" CHECK ("kind" IS NULL OR "kind" IN ('OOH_ARTWORK', 'OOH_START_REPORT', 'OOH_PERIODIC_REPORT', 'OOH_END_REPORT'));
