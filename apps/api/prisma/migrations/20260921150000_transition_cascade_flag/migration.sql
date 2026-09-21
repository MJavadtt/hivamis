-- A transition written by a cascade says so (roadmap #1 needs to tell them apart, and a Persian
-- reason is not a reliable marker).

-- AlterTable
ALTER TABLE "state_transitions" ADD COLUMN     "cascade" BOOLEAN NOT NULL DEFAULT false;


