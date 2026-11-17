-- «حرف اختصاری واحد» by the owner's coding instruction QA-WI-001/00 (ADR-133).
ALTER TABLE "departments" ADD COLUMN "shortCode" TEXT;

UPDATE "departments" SET "shortCode" = CASE "code"
  WHEN 'M' THEN 'MA' WHEN 'S' THEN 'SA' WHEN 'A' THEN 'AC' WHEN 'ST' THEN 'QC' WHEN 'CR' THEN 'IC'
  WHEN 'ME' THEN 'MD' WHEN 'DM' THEN 'PM' WHEN 'FI' THEN 'FA' WHEN 'LG' THEN 'LG' WHEN 'OP' THEN 'OP' END
WHERE "code" IN ('M','S','A','ST','CR','ME','DM','FI','LG','OP');

-- The instruction's units the process has no station for, once for each organisation.
INSERT INTO "departments" ("id", "organizationId", "code", "shortCode", "nameFa", "nameEn", "namesOwned", "sortOrder", "updatedAt")
SELECT gen_random_uuid(), o."id", 'XVP', 'VP', 'نماینده مدیریت', 'Management Representative', true, 100, now() FROM "organizations" o
WHERE NOT EXISTS (SELECT 1 FROM "departments" d WHERE d."organizationId" = o."id" AND d."code" = 'XVP');
INSERT INTO "departments" ("id", "organizationId", "code", "shortCode", "nameFa", "nameEn", "namesOwned", "sortOrder", "updatedAt")
SELECT gen_random_uuid(), o."id", 'XQA', 'QA', 'تضمین کیفیت', 'Quality Assurance', true, 101, now() FROM "organizations" o
WHERE NOT EXISTS (SELECT 1 FROM "departments" d WHERE d."organizationId" = o."id" AND d."code" = 'XQA');
INSERT INTO "departments" ("id", "organizationId", "code", "shortCode", "nameFa", "nameEn", "namesOwned", "sortOrder", "updatedAt")
SELECT gen_random_uuid(), o."id", 'XIT', 'IT', 'انفورماتیک', 'IT', true, 102, now() FROM "organizations" o
WHERE NOT EXISTS (SELECT 1 FROM "departments" d WHERE d."organizationId" = o."id" AND d."code" = 'XIT');
INSERT INTO "departments" ("id", "organizationId", "code", "shortCode", "nameFa", "nameEn", "namesOwned", "sortOrder", "updatedAt")
SELECT gen_random_uuid(), o."id", 'XHR', 'HR', 'منابع انسانی', 'Human Resources', true, 103, now() FROM "organizations" o
WHERE NOT EXISTS (SELECT 1 FROM "departments" d WHERE d."organizationId" = o."id" AND d."code" = 'XHR');
INSERT INTO "departments" ("id", "organizationId", "code", "shortCode", "nameFa", "nameEn", "namesOwned", "sortOrder", "updatedAt")
SELECT gen_random_uuid(), o."id", 'XCO', 'CO', 'بازرگانی', 'Commerce', true, 104, now() FROM "organizations" o
WHERE NOT EXISTS (SELECT 1 FROM "departments" d WHERE d."organizationId" = o."id" AND d."code" = 'XCO');
INSERT INTO "departments" ("id", "organizationId", "code", "shortCode", "nameFa", "nameEn", "namesOwned", "sortOrder", "updatedAt")
SELECT gen_random_uuid(), o."id", 'XST', 'ST', 'انبار', 'Warehouse', true, 105, now() FROM "organizations" o
WHERE NOT EXISTS (SELECT 1 FROM "departments" d WHERE d."organizationId" = o."id" AND d."code" = 'XST');

CREATE UNIQUE INDEX "departments_organizationId_shortCode_key" ON "departments"("organizationId", "shortCode");
