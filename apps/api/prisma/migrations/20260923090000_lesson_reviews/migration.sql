-- What the team did with each past lesson at kick-off (roadmap #44). Doc_H makes lessons
-- mandatory at closure; recording whether a new project actually used one is what separates
-- learning from archiving.
CREATE TABLE "lesson_reviews" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "lessonId" TEXT NOT NULL,
    "decision" TEXT NOT NULL,
    "note" TEXT,
    "reviewedById" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "lesson_reviews_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "lesson_reviews_organizationId_projectId_idx" ON "lesson_reviews"("organizationId", "projectId");
CREATE UNIQUE INDEX "lesson_reviews_projectId_lessonId_key" ON "lesson_reviews"("projectId", "lessonId");

ALTER TABLE "lesson_reviews" ADD CONSTRAINT "lesson_reviews_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "projects"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "lesson_reviews" ADD CONSTRAINT "lesson_reviews_lessonId_fkey" FOREIGN KEY ("lessonId") REFERENCES "lessons_learned"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "lesson_reviews" DROP CONSTRAINT IF EXISTS "lesson_reviews_decision_check";
ALTER TABLE "lesson_reviews" ADD CONSTRAINT "lesson_reviews_decision_check" CHECK ("decision" IN ('APPLIED', 'NOT_RELEVANT'));
