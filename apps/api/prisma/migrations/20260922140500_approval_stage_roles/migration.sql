-- The roles that may decide a submission right now: the waiting stage's roles (roadmap #18).
-- A column rather than a JSON lookup so an approval inbox stays one query.
ALTER TABLE "form_submissions" ADD COLUMN     "currentRoles" TEXT[] DEFAULT ARRAY[]::TEXT[];
