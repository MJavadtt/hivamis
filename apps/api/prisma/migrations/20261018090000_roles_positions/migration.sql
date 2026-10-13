-- Audit F-3: roles an organisation makes for itself, and a catalogue of positions.

-- A role with an organisation is that organisation's own; without one, it is the code's, everyone's.
ALTER TABLE "roles" ADD COLUMN "color" TEXT,
ADD COLUMN "organizationId" TEXT;
ALTER TABLE "roles" ADD CONSTRAINT "roles_color_check" CHECK ("color" IS NULL OR "color" ~ '^#[0-9a-f]{6}$');
CREATE INDEX "roles_organizationId_idx" ON "roles"("organizationId");
ALTER TABLE "roles" ADD CONSTRAINT "roles_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "positions" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "nameFa" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL DEFAULT '',
    "departmentId" TEXT,
    "defaultRoleCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "positions_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "positions_organizationId_nameFa_key" ON "positions"("organizationId", "nameFa");
ALTER TABLE "positions" ADD CONSTRAINT "positions_organizationId_fkey" FOREIGN KEY ("organizationId") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "positions" ADD CONSTRAINT "positions_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "users" ADD COLUMN "positionId" TEXT;
ALTER TABLE "users" ADD CONSTRAINT "users_positionId_fkey" FOREIGN KEY ("positionId") REFERENCES "positions"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Every job title already written becomes a position of its organisation, in the unit most of its
-- holders are in, and its holders are given it. The text stays on the user as the fallback.
INSERT INTO "positions" ("id", "organizationId", "nameFa", "departmentId", "updatedAt")
SELECT gen_random_uuid()::text, t."organizationId", t."jobTitle",
       (SELECT u2."departmentId" FROM "users" u2
         WHERE u2."organizationId" = t."organizationId" AND u2."jobTitle" = t."jobTitle" AND u2."departmentId" IS NOT NULL
         GROUP BY u2."departmentId" ORDER BY count(*) DESC, u2."departmentId" LIMIT 1),
       CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "organizationId", btrim("jobTitle") AS "jobTitle" FROM "users"
       WHERE "jobTitle" IS NOT NULL AND btrim("jobTitle") <> '' AND "deletedAt" IS NULL) t;

UPDATE "users" u SET "positionId" = p."id"
FROM "positions" p
WHERE p."organizationId" = u."organizationId" AND p."nameFa" = btrim(u."jobTitle");
