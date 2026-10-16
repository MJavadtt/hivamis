-- List 3, item 6: the units the organisation runs. Doc_H's ten units stay what the process routes to;
-- an organisation may rename one (and keep the name across upgrades), choose its manager, and divide
-- it into teams — Creative's «طراحی» and «ویدئو».
ALTER TABLE "departments" ADD COLUMN "namesOwned" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "users" ADD COLUMN "teamId" TEXT;

CREATE TABLE "teams" (
    "id" TEXT NOT NULL,
    "organizationId" TEXT NOT NULL,
    "departmentId" TEXT NOT NULL,
    "nameFa" TEXT NOT NULL,
    "nameEn" TEXT NOT NULL DEFAULT '',
    "leadId" TEXT,
    "color" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "teams_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "teams_values" CHECK (
      char_length("nameFa") BETWEEN 2 AND 60 AND char_length("nameEn") <= 60
      AND ("color" IS NULL OR "color" ~ '^#[0-9a-f]{6}$')
    )
);

CREATE INDEX "teams_departmentId_idx" ON "teams"("departmentId");
CREATE UNIQUE INDEX "teams_organizationId_departmentId_nameFa_key" ON "teams"("organizationId", "departmentId", "nameFa");

ALTER TABLE "users" ADD CONSTRAINT "users_teamId_fkey" FOREIGN KEY ("teamId") REFERENCES "teams"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "teams" ADD CONSTRAINT "teams_departmentId_fkey" FOREIGN KEY ("departmentId") REFERENCES "departments"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "teams" ADD CONSTRAINT "teams_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- A person's team is in their own unit: what the API checks, the database refuses outright.
-- The table is named through the trigger's own schema: a function body resolves names on the search
-- path, and the tests copy the tables into schemas of their own.
CREATE OR REPLACE FUNCTION hiva_team_in_unit() RETURNS trigger AS $$
DECLARE found integer;
BEGIN
  IF NEW."teamId" IS NULL THEN RETURN NEW; END IF;
  EXECUTE format('SELECT 1 FROM %I."teams" t WHERE t."id" = $1 AND t."departmentId" IS NOT DISTINCT FROM $2 AND t."archivedAt" IS NULL', TG_TABLE_SCHEMA)
    INTO found USING NEW."teamId", NEW."departmentId";
  IF found IS NULL THEN
    RAISE EXCEPTION 'a person''s team must be an open team of their own unit' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER hiva_team_in_unit BEFORE INSERT OR UPDATE OF "teamId", "departmentId" ON "users"
  FOR EACH ROW EXECUTE FUNCTION hiva_team_in_unit();
