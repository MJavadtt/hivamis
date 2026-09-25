-- Brief quality, beside brief completeness (roadmap #25). Completeness asks whether a field is
-- filled; quality asks whether it says anything specific. Stored so returns can be read against it.
ALTER TABLE "briefs" ADD COLUMN "qualityScore" INTEGER,
ADD COLUMN "qualityBand" TEXT;
