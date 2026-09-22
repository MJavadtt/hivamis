-- Conditional approval routing (roadmap #17). Rules live on the definition and are versioned
-- with it; a submission keeps the roles it required and the rules that put them there.
ALTER TABLE "form_definition_versions" ADD COLUMN     "routing" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "form_definitions" ADD COLUMN     "routing" JSONB NOT NULL DEFAULT '[]';
ALTER TABLE "form_submissions" ADD COLUMN     "requiredRoles" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "routing" JSONB;
