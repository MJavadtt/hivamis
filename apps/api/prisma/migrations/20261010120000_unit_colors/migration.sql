-- Hivamis task 9: the system administrator sets each unit's tag colour.
ALTER TABLE "departments" ADD COLUMN "tagColor" TEXT;

-- Only a #rrggbb colour, lower case, as the API stores it; null shows the unit's default.
ALTER TABLE "departments" ADD CONSTRAINT "departments_tag_color_hex" CHECK ("tagColor" IS NULL OR "tagColor" ~ '^#[0-9a-f]{6}$');
