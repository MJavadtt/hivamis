-- The form designer (roadmap #15). A definition the organisation has edited is marked, so the
-- seed stops pushing the catalogue's schema over it; a form the organisation added itself is
-- outside the Doc_H catalogue entirely.
ALTER TABLE "form_definitions" ADD COLUMN     "customizedAt" TIMESTAMP(3),
ADD COLUMN     "customizedById" TEXT,
ADD COLUMN     "isCustom" BOOLEAN NOT NULL DEFAULT false;
